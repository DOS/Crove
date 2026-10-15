// Egress probe for the `extract-image` CI job (External-tenant gate T12). The job runs it in the network namespace
// of the crove-extract container (docker run --network container:<name>), where every probe must fail, and once
// on an ordinary network as a control, where the probes should succeed (so a failure there means the probes are
// broken, not that egress is blocked). Usage: node egress.mjs blocked|control
//
// IPv6: many hosts and CI runners have no IPv6 route at all, so on an ordinary network the IPv6 control is
// skipped when there is no global IPv6 address or the probe fails with "no route" (an address but no way out, as
// on an IPv6 Docker network of a host without IPv6). A timeout or a refusal still fails the control. In blocked
// mode nothing is ever skipped: an IPv6 probe that cannot even start (no IPv6 in the namespace) counts as blocked,
// which is what it is.
import { promises as dns } from 'node:dns';
import { createSocket } from 'node:dgram';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';

const mode = process.argv[2] === 'control' ? 'control' : 'blocked';
const TIMEOUT_MS = 5000;

const tcp = (host, port) =>
  new Promise((resolve, reject) => {
    const socket = connect(port, host);
    socket.setTimeout(TIMEOUT_MS, () => {
      socket.destroy();
      reject(new Error('timeout'));
    });
    socket.on('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.on('error', reject);
  });

// A raw DNS query (A record of example.com) over UDP; only a reply with the query's id counts as reached.
const udpDns = (host, port) =>
  new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 0x10000);
    const name = Buffer.concat([
      ...'example.com'.split('.').map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, 'ascii')])),
      Buffer.from([0]),
    ]);
    const header = Buffer.from([id >> 8, id & 0xff, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const query = Buffer.concat([header, name, Buffer.from([0x00, 0x01, 0x00, 0x01])]);
    const socket = createSocket('udp4');
    const finish = (error) => {
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error('timeout')), TIMEOUT_MS);
    socket.on('error', finish);
    socket.on('message', (reply) => {
      if (reply.length >= 12 && reply.readUInt16BE(0) === id && (reply[2] & 0x80) !== 0) finish();
    });
    socket.send(query, port, host, (error) => {
      if (error) finish(error);
    });
  });

// A global (routable) IPv6 address on a non-loopback interface; link-local fe80::/10 does not count.
function hasGlobalIpv6() {
  return Object.values(networkInterfaces())
    .flat()
    .some((a) => a && a.family === 'IPv6' && !a.internal && !/^fe[89ab]/i.test(a.address));
}

const probes = [
  ['TCP 1.1.1.1:443', () => tcp('1.1.1.1', 443)],
  ['TCP 8.8.8.8:53', () => tcp('8.8.8.8', 53)],
  ['TCP [2606:4700:4700::1111]:443', () => tcp('2606:4700:4700::1111', 443), { ipv6: true }],
  ['UDP DNS query 1.1.1.1:53', () => udpDns('1.1.1.1', 53)],
  ['DNS lookup example.com', () => dns.lookup('example.com')],
  ['HTTPS https://example.com', () => fetch('https://example.com', { signal: AbortSignal.timeout(TIMEOUT_MS) })],
];

// Errors that mean this network has no IPv6 path at all, not that the probe is broken.
const NO_IPV6_ROUTE = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'EAFNOSUPPORT']);

const ipv6 = hasGlobalIpv6();
let reached = 0;
let expected = 0;
for (const [name, probe, flags] of probes) {
  if (mode === 'control' && flags?.ipv6 && !ipv6) {
    console.log(`skipped  ${name} (control only: this network has no global IPv6 address)`);
    continue;
  }
  expected += 1;
  try {
    await probe();
    reached += 1;
    console.log(`reached  ${name}`);
  } catch (error) {
    const code = error?.cause?.code ?? error?.code ?? error?.message;
    if (mode === 'control' && flags?.ipv6 && NO_IPV6_ROUTE.has(code)) {
      expected -= 1;
      console.log(`skipped  ${name} (control only: no IPv6 route out of this network, ${code})`);
      continue;
    }
    console.log(`blocked  ${name} (${code})`);
  }
}

if (mode === 'blocked' && reached > 0) {
  console.error(`crove-extract reached the outside ${reached} time(s); it must have no egress`);
  process.exit(1);
}
if (mode === 'control' && reached < expected) {
  console.error('control: some probes failed on an ordinary network; the egress check would prove nothing');
  process.exit(1);
}
