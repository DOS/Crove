// Egress probe for the `extract-image` CI job (External-tenant gate T12). The job runs it in the network namespace
// of the crove-extract container (docker run --network container:<name>), where every probe must fail, and once
// on an ordinary network as a control, where the probes should succeed (so a failure there means the probes are
// broken, not that egress is blocked). Usage: node egress.mjs blocked|control
import { promises as dns } from 'node:dns';
import { connect } from 'node:net';

const mode = process.argv[2] === 'control' ? 'control' : 'blocked';

const tcp = (host, port) =>
  new Promise((resolve, reject) => {
    const socket = connect(port, host);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error('timeout'));
    });
    socket.on('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.on('error', reject);
  });

const probes = [
  ['TCP 1.1.1.1:443', () => tcp('1.1.1.1', 443)],
  ['TCP 8.8.8.8:53', () => tcp('8.8.8.8', 53)],
  ['DNS lookup example.com', () => dns.lookup('example.com')],
  ['HTTPS https://example.com', () => fetch('https://example.com', { signal: AbortSignal.timeout(5000) })],
];

let reached = 0;
for (const [name, probe] of probes) {
  try {
    await probe();
    reached += 1;
    console.log(`reached  ${name}`);
  } catch (error) {
    console.log(`blocked  ${name} (${error?.cause?.code ?? error?.code ?? error?.message})`);
  }
}

if (mode === 'blocked' && reached > 0) {
  console.error(`crove-extract reached the outside ${reached} time(s); it must have no egress`);
  process.exit(1);
}
if (mode === 'control' && reached < probes.length) {
  console.error('control: some probes failed on an ordinary network; the egress check would prove nothing');
  process.exit(1);
}
