// crove-extract (External-tenant gate T12): the HTTP limits, the parser process limits, what the parser process
// cannot do (network, file writes, child processes, environment) and the credential guard at startup.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXTRACT_CLIENT_TIMEOUT_MS, EXTRACT_KINDS, EXTRACT_LIMITS, EXTRACT_TIMING, worstCaseCallMs, zExtractResponse, type ExtractResponse } from '@crove/extract-contract';
import { IMAGE_MARKER, credentialVariables, enforcesAllowlist, loadExtractConfig, unexpectedVariables } from '../src/main.ts';
import { DEFAULT_SANDBOX, PARSER_ENV, classifyExit, parserFlags, runSandboxed } from '../src/sandbox.ts';
import { createExtractApp, createLimiter, type Runner } from '../src/server.ts';
import { signInvoice, testPki } from './einvoice-signing-fixture.ts';

const FIXTURE = readFileSync(new URL('./fixtures/einvoice-basic.xml', import.meta.url));
const encode = (text: string) => new TextEncoder().encode(text);
// A marker path that never exists, so the tests do not depend on the machine they run on.
const NO_MARKER = join(tmpdir(), `crove-extract-no-marker-${process.pid}`, 'none');

// A one-page PDF with a text layer.
function pdf(text: string): Uint8Array<ArrayBuffer> {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encode(out);
}

function email(attachment: Uint8Array, filename = 'hd.xml'): Uint8Array<ArrayBuffer> {
  const base64 = Buffer.from(attachment).toString('base64').replace(/(.{76})/g, '$1\r\n');
  return encode(
    [
      'From: Vendor <billing@vendor.example>',
      'To: abc@in.test, Group: one@in.test;',
      'Delivered-To: 0123456789abcdef01234567@in.test',
      'Subject: Hoa don',
      'Message-ID: <hd-1@vendor.example>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain',
      '',
      'Xin gui hoa don.',
      '--b1',
      'Content-Type: application/octet-stream',
      `Content-Disposition: attachment; filename="${filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      base64,
      '--b1--',
      '',
    ].join('\r\n'),
  );
}

const post = (app: ReturnType<typeof createExtractApp>, kind: string, body: BodyInit, headers: Record<string, string> = {}) =>
  app.request(`/extract?kind=${kind}`, { method: 'POST', body, headers: { 'content-type': 'application/octet-stream', ...headers } });

async function answer(response: Response): Promise<ExtractResponse> {
  return zExtractResponse.parse(await response.json());
}

describe('crove-extract HTTP service', () => {
  it('parses an e-invoice XML in the sandbox and answers with the contract shape', async () => {
    const app = createExtractApp();
    const response = await post(app, 'einvoice_xml', FIXTURE);
    expect(response.status).toBe(200);
    const result = await answer(response);
    expect(result).toMatchObject({ ok: true, kind: 'einvoice_xml', invoice: { number: '1234', total: '1980000', source: 'einvoice_xml' } });
  });

  it('extracts the text layer of a PDF', async () => {
    const result = await answer(await post(createExtractApp(), 'pdf_text', pdf('Hoa don GTGT so 1234')));
    expect(result).toEqual({ ok: true, kind: 'pdf_text', text: 'Hoa don GTGT so 1234', pages: 1 });
  });

  it('parses a MIME message: addresses, subject and attachments as base64', async () => {
    const result = await answer(await post(createExtractApp(), 'mime', email(FIXTURE)));
    if (!result.ok || result.kind !== 'mime') throw new Error(`unexpected ${JSON.stringify(result)}`);
    expect(result.email).toMatchObject({
      messageId: '<hd-1@vendor.example>',
      from: 'billing@vendor.example',
      subject: 'Hoa don',
      deliveredTo: '0123456789abcdef01234567@in.test',
      to: ['abc@in.test'],
    });
    expect(result.email.attachments).toHaveLength(1);
    expect(Buffer.from(result.email.attachments[0]?.content ?? '', 'base64')).toEqual(FIXTURE);
  });

  // #779: a forwarded mail's text, for an AI draft of a Social post.
  describe("a mail's text", () => {
    const mail = (contentType: string, body: string): Uint8Array<ArrayBuffer> =>
      encode(['From: Shop <hello@shop.example>', 'Subject: Khuyen mai', 'Message-ID: <km-1@shop.example>', 'MIME-Version: 1.0', `Content-Type: ${contentType}; charset=utf-8`, 'Content-Transfer-Encoding: 8bit', '', body].join('\r\n'));
    const textOf = async (bytes: Uint8Array<ArrayBuffer>) => {
      const result = await answer(await post(createExtractApp(), 'mime', bytes));
      if (!result.ok || result.kind !== 'mime') throw new Error(`unexpected ${JSON.stringify(result)}`);
      return result.email.text;
    };

    it('keeps the text/plain part, with control characters dropped and blank lines collapsed', async () => {
      expect(await textOf(mail('text/plain', 'Giảm 20%\u0007 cho đơn đầu.\r\n\r\n\r\n\r\nHẹn gặp   bạn!   '))).toBe('Giảm 20% cho đơn đầu.\n\nHẹn gặp bạn!');
    });

    it('reduces an HTML-only mail to text, without its scripts and styles', async () => {
      const text = await textOf(mail('text/html', '<html><head><style>p{color:red}</style></head><body><p>Mở bán <b>bánh trung thu</b></p><script>alert(1)</script><p>Từ 1/9</p></body></html>'));
      expect(text).toContain('Mở bán bánh trung thu');
      expect(text).toContain('Từ 1/9');
      expect(text).not.toContain('alert');
      expect(text).not.toContain('color:red');
    });

    it('caps a long text at maxMailTextChars and gives none for an empty mail', async () => {
      const long = await textOf(mail('text/plain', 'a'.repeat(EXTRACT_LIMITS.maxMailTextChars + 500)));
      expect(long?.length).toBe(EXTRACT_LIMITS.maxMailTextChars);
      expect(await textOf(mail('text/plain', '   \r\n  '))).toBeNull();
    });
  });

  it('refuses a declared body over the limit before reading it', async () => {
    let calls = 0;
    const run: Runner = async () => {
      calls += 1;
      return { ok: false, code: 'internal', message: 'unreachable' };
    };
    const app = createExtractApp({ run });
    const response = await post(app, 'einvoice_xml', encode('<HDon/>'), { 'content-length': String(EXTRACT_LIMITS.maxFileBytes + 1) });
    expect(response.status).toBe(413);
    expect(await answer(response)).toMatchObject({ ok: false, code: 'too_large' });
    expect(calls).toBe(0);
  });

  it('cuts off a streamed body as soon as it passes the limit', async () => {
    let calls = 0;
    let pulled = 0;
    const run: Runner = async () => {
      calls += 1;
      return { ok: false, code: 'internal', message: 'unreachable' };
    };
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        // Far more than the limit if read to the end.
        if (pulled > 200) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const app = createExtractApp({ run });
    const response = await app.request('/extract?kind=pdf_text', { method: 'POST', body, duplex: 'half' } as RequestInit);
    expect(response.status).toBe(413);
    expect(calls).toBe(0);
    expect(pulled).toBeLessThan(40);
  });

  it('answers 400 for an unknown kind and 422 for an empty body', async () => {
    const app = createExtractApp();
    const unknown = await post(app, 'docx', encode('x'));
    expect(unknown.status).toBe(400);
    const refusal = await answer(unknown);
    expect(refusal).toMatchObject({ code: 'bad_request' });
    // The message names every kind the service takes, so it cannot fall behind EXTRACT_KINDS.
    for (const kind of EXTRACT_KINDS) expect(refusal).toMatchObject({ message: expect.stringContaining(kind) });
    const empty = await post(app, 'einvoice_xml', new Uint8Array(0));
    expect(empty.status).toBe(422);
    expect(await answer(empty)).toMatchObject({ code: 'invalid' });
  });

  it('answers 503 busy when every parser slot and queue place is taken', async () => {
    let release = () => {};
    const run: Runner = () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: false, code: 'invalid', message: 'x' });
      });
    const app = createExtractApp({ run, concurrency: 1, maxQueue: 0 });
    const first = post(app, 'einvoice_xml', encode('<a/>'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await post(app, 'einvoice_xml', encode('<a/>'));
    expect(second.status).toBe(503);
    expect(await answer(second)).toMatchObject({ code: 'busy' });
    release();
    expect((await first).status).toBe(422);
  });
});

describe('crove-extract parser slots', () => {
  const never = new AbortController().signal;

  it('hands a finished slot to the next waiter, so a newcomer never runs alongside it', async () => {
    const limit = createLimiter(1, 4);
    let running = 0;
    let most = 0;
    const releases: Array<() => void> = [];
    const task = () =>
      new Promise<string>((resolve) => {
        running += 1;
        most = Math.max(most, running);
        releases.push(() => {
          running -= 1;
          resolve('done');
        });
      });
    const first = limit(never, task);
    const second = limit(never, task);
    await new Promise((resolve) => setTimeout(resolve, 0));
    releases.shift()?.();
    // Arrives in the same tick the first slot is released.
    const third = limit(never, task);
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      releases.shift()?.();
    }
    expect(await Promise.all([first, second, third])).toEqual(['done', 'done', 'done']);
    expect(most).toBe(1);
  });

  it('drops a waiter whose caller gave up, freeing its queue place', async () => {
    const limit = createLimiter(1, 1);
    let release = () => {};
    const first = limit(never, () => new Promise<string>((resolve) => (release = () => resolve('first'))));
    const gone = new AbortController();
    const waiting = limit(gone.signal, async () => 'ran');
    expect(await limit(never, async () => 'ran')).toBe('busy');
    gone.abort();
    expect(await waiting).toBe('aborted');
    const next = limit(never, async () => 'next');
    release();
    expect(await first).toBe('first');
    expect(await next).toBe('next');
  });

  it('kills the parser process when the caller goes away', async () => {
    const gone = new AbortController();
    const pending = runSandboxed('einvoice_xml', FIXTURE, DEFAULT_SANDBOX, gone.signal);
    gone.abort();
    expect(await pending).toEqual({ ok: false, code: 'internal', message: 'caller went away' });
  });
});

describe('crove-extract parser process', () => {
  it('refuses XML entity expansion (billion laughs) without expanding anything', async () => {
    const laughs = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE lolz [<!ENTITY lol "lol">',
      ...Array.from({ length: 9 }, (_, i) => `<!ENTITY lol${i + 1} "${`&lol${i === 0 ? '' : i};`.repeat(10)}">`),
      ']>',
      '<HDon>&lol9;</HDon>',
    ].join('\n');
    const result = await runSandboxed('einvoice_xml', encode(laughs));
    expect(result).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/DOCTYPE/) });
  });

  it('bounds deeply nested input with a typed error', async () => {
    const depth = 200_000;
    const nested = `${'<a>'.repeat(depth)}${'</a>'.repeat(depth)}`;
    const result = await runSandboxed('einvoice_xml', encode(nested));
    expect(result).toMatchObject({ ok: false, code: 'invalid' });
    const mime = encode(
      `${Array.from({ length: 100 }, (_, i) => `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n`).join('')}Content-Type: text/plain\r\n\r\nx\r\n`,
    );
    // 100 nested multiparts, over the parser's nesting limit of 32.
    expect(await runSandboxed('mime', mime)).toEqual({ ok: false, code: 'invalid', message: 'Không đọc được thư điện tử' });
  });

  it('verifies an e-invoice signature inside the parser process (#674)', async () => {
    // Signed by the TEST ONLY PKI, which the shipped national roots do not trust. untrusted_certificate is decided only
    // after xml-crypto checked the references and the signature value, and after the chain was built from the
    // shipped trust files: all of it ran under the parser's permission model, with no network or code generation.
    const pki = testPki();
    const unsigned = FIXTURE.toString('utf8').replace(/<DSCKS>[\s\S]*<\/DSCKS>/, '<DSCKS><NBan></NBan></DSCKS>');
    const signed = signInvoice(unsigned.replace(/<MCCQT[^>]*>[^<]*<\/MCCQT>/, ''), pki.seller, { slot: 'NBan' });
    const result = await runSandboxed('einvoice_xml', encode(signed));
    expect(result).toMatchObject({ ok: true, invoice: { total: '1980000', signature: { status: 'unverified', reason: 'untrusted_certificate', signer: 'TEST ONLY CÔNG TY TNHH DỊCH VỤ MẪU' } } });
    const tampered = await runSandboxed('einvoice_xml', encode(signed.replace('<TgTTTBSo>1980000</TgTTTBSo>', '<TgTTTBSo>1980001</TgTTTBSo>')));
    expect(tampered).toMatchObject({ ok: true, invoice: { signature: { status: 'unverified', reason: 'digest_mismatch' } } });
  });

  it('gives a typed error for malformed input and leaks no parser internals', async () => {
    expect(await runSandboxed('pdf_text', encode('%PDF-1.4 not really a pdf'))).toEqual({ ok: false, code: 'invalid', message: 'Không đọc được tệp PDF' });
    expect(await runSandboxed('einvoice_xml', encode('<root><a>1</a></root>'))).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/HDon/) });
    expect(await runSandboxed('einvoice_xml', encode('<HDon><DLHDon>'))).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('kills a parse at the time limit', async () => {
    const started = Date.now();
    const result = await runSandboxed('einvoice_xml', FIXTURE, { ...DEFAULT_SANDBOX, timeoutMs: 50 });
    expect(result).toEqual({ ok: false, code: 'timeout', message: 'parsing took longer than 50 ms' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('stops a parse that needs more heap than allowed', async () => {
    const big = Buffer.alloc(20 * 1024 * 1024, 7);
    const result = await runSandboxed('mime', email(big, 'big.bin'), { ...DEFAULT_SANDBOX, maxHeapMb: 24 });
    expect(result).toMatchObject({ ok: false, code: 'memory' });
  }, 30_000);

  // Buffers are outside the V8 heap limit; the resident memory watchdog reads /proc, so it runs on Linux (CI).
  it.runIf(process.platform === 'linux')('stops a parse whose resident memory passes the limit, Buffers included', async () => {
    const big = Buffer.alloc(20 * 1024 * 1024, 7);
    const result = await runSandboxed('mime', email(big, 'big.bin'), { ...DEFAULT_SANDBOX, maxRssMb: 64 });
    expect(result).toEqual({ ok: false, code: 'memory', message: 'parsing needed more than 64 MB of memory' });
  }, 30_000);

  it('reports a kill it did not send (the kernel OOM killer) as memory, other crashes as internal', () => {
    expect(classifyExit(null, 'SIGKILL', '')).toMatchObject({ code: 'memory' });
    expect(classifyExit(137, null, '')).toMatchObject({ code: 'memory' });
    expect(classifyExit(134, 'SIGABRT', 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory')).toMatchObject({
      code: 'memory',
    });
    expect(classifyExit(1, null, 'TypeError: boom')).toMatchObject({ code: 'internal' });
    expect(classifyExit(0, null, '')).toBeNull();
  });

  it('refuses an answer larger than the output limit', async () => {
    const result = await runSandboxed('mime', email(FIXTURE), { ...DEFAULT_SANDBOX, maxOutputBytes: 64 });
    expect(result).toMatchObject({ ok: false, code: 'invalid' });
  });
});

// Runs a script under exactly the parser process's flags and environment.
function underSandbox(script: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...parserFlags(DEFAULT_SANDBOX), '--input-type=module', '-e', script], { env: PARSER_ENV, windowsHide: true });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('close', (code) => resolve({ code, out }));
  });
}

// These tests assert Node's permission model (--permission, ERR_ACCESS_DENIED). Bun ignores those flags, and the service
// ships and runs on Node only (see the Dockerfile), so the nightly Bun canary skips them instead of failing on every run.
const onBun = 'bun' in process.versions;

describe.skipIf(onBun)('crove-extract parser process isolation', () => {
  it('cannot open a network connection', async () => {
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as { port: number };
    try {
      const { out } = await underSandbox(`
        import net from 'node:net';
        const results = [];
        await new Promise((done) => {
          try {
            const s = net.connect(${port}, '127.0.0.1');
            s.on('connect', () => { results.push('connected'); s.destroy(); done(); });
            s.on('error', (e) => { results.push('net:' + e.code); done(); });
          } catch (e) { results.push('net:' + e.code); done(); }
        });
        await fetch('http://127.0.0.1:${port}/').then(() => results.push('fetched'), (e) => results.push('fetch:' + (e.cause?.code ?? e.code ?? e.message)));
        console.log(JSON.stringify(results));
      `);
      expect(out).toContain('net:ERR_ACCESS_DENIED');
      expect(out).not.toContain('connected');
      expect(out).not.toContain('fetched');
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('has an empty environment and cannot write files or start processes', async () => {
    const target = join(tmpdir(), `crove-extract-${process.pid}.txt`);
    const { out } = await underSandbox(`
      import fs from 'node:fs';
      import cp from 'node:child_process';
      // On Windows, libuv always adds the variables a process needs to start; there are none on Linux.
      const windows = /^(HOMEDRIVE|HOMEPATH|LOGONSERVER|PATH|SYSTEMDRIVE|SYSTEMROOT|TEMP|USERDOMAIN|USERNAME|USERPROFILE|WINDIR)$/i;
      const results = { env: Object.keys(process.env).filter((k) => process.platform !== 'win32' || !windows.test(k)) };
      try { fs.writeFileSync(${JSON.stringify(target)}, 'x'); results.write = 'written'; } catch (e) { results.write = e.code; }
      try { cp.execFileSync(process.execPath, ['-v']); results.spawn = 'spawned'; } catch (e) { results.spawn = e.code; }
      console.log(JSON.stringify(results));
    `);
    const results = JSON.parse(out.trim().split('\n').pop() ?? '{}') as { env: string[]; write: string; spawn: string };
    expect(results).toEqual({ env: [], write: 'ERR_ACCESS_DENIED', spawn: 'ERR_ACCESS_DENIED' });
  });

  it('cannot read outside its own code or start worker threads', async () => {
    const outside = [
      // The checkout around the app in development: secrets and data live there.
      fileURLToPath(new URL('../../../.env', import.meta.url)),
      fileURLToPath(new URL('../../../package.json', import.meta.url)),
      process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd',
    ];
    const { out } = await underSandbox(`
      import fs from 'node:fs';
      import { Worker } from 'node:worker_threads';
      const results = { reads: [] };
      for (const path of ${JSON.stringify(outside)}) {
        try { fs.readFileSync(path); results.reads.push('read'); } catch (e) { results.reads.push(e.code); }
      }
      try { new Worker('setTimeout(() => {}, 10)', { eval: true }); results.worker = 'started'; } catch (e) { results.worker = e.code; }
      console.log(JSON.stringify(results));
    `);
    const results = JSON.parse(out.trim().split('\n').pop() ?? '{}') as { reads: string[]; worker: string };
    expect(results).toEqual({ reads: ['ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED'], worker: 'ERR_ACCESS_DENIED' });
  });
});

describe('crove-extract configuration', () => {
  it('refuses to start with credentials in its environment, naming them and never their values', () => {
    const env = {
      NODE_ENV: 'production',
      PORT: '8090',
      DATABASE_URL: 'postgres://u:hunter2@db/x',
      AI_API_KEY: 'sk-secret-value',
      S3_SECRET_ACCESS_KEY: 'abc',
      PATH: '/usr/bin',
    };
    expect(credentialVariables(env)).toEqual(['AI_API_KEY', 'DATABASE_URL', 'S3_SECRET_ACCESS_KEY']);
    expect(() => loadExtractConfig(env)).toThrow(/AI_API_KEY, DATABASE_URL, S3_SECRET_ACCESS_KEY/);
    expect(() => loadExtractConfig(env)).not.toThrow(/hunter2|sk-secret-value/);
  });

  it('in production, refuses any variable outside the allowlist, credential-like or not', () => {
    // What the image and a container runtime set, plus every setting of the service.
    const image = {
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: '8090',
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/home/node',
      HOSTNAME: 'a1b2c3',
      NODE_VERSION: '26.0.0',
      YARN_VERSION: '1.22.22',
      EXTRACT_CONCURRENCY: '1',
      EXTRACT_MAX_QUEUE: '1',
      EXTRACT_TIMEOUT_MS: '25000',
      EXTRACT_MAX_HEAP_MB: '512',
      EXTRACT_MAX_RSS_MB: '768',
    };
    expect(unexpectedVariables(image)).toEqual([]);
    expect(loadExtractConfig(image).PORT).toBe(8090);
    for (const name of ['NODE_OPTIONS', 'HTTPS_PROXY', 'CROVE_EXTRA', 'KERNEL_SERVICE_HOST', 'MY_CONN']) {
      expect(() => loadExtractConfig({ ...image, [name]: 'value-123' }), name).toThrow(new RegExp(`remove ${name} from`));
      expect(() => loadExtractConfig({ ...image, [name]: 'value-123' })).not.toThrow(/value-123/);
    }
    // Set but empty still counts: the name alone says something was meant to reach the service.
    expect(() => loadExtractConfig({ ...image, AI_API_KEY: '' })).toThrow(/AI_API_KEY/);
    expect(unexpectedVariables({ ...image, B_VAR: 'x', A_VAR: 'y' })).toEqual(['A_VAR', 'B_VAR']);
  });

  it('only warns about credentials in an explicit development or test run, still without values', () => {
    for (const nodeEnv of ['development', 'test']) {
      const warnings: string[] = [];
      // A development shell holds many variables outside the allowlist; only credential-like names are mentioned.
      const config = loadExtractConfig({ NODE_ENV: nodeEnv, GITHUB_TOKEN: 'ghp_value', TERM_PROGRAM: 'vscode' }, (m) => warnings.push(m), {
        markerPath: NO_MARKER,
      });
      expect(config.PORT).toBe(8090);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/GITHUB_TOKEN/);
      expect(warnings[0]).not.toMatch(/ghp_value|TERM_PROGRAM/);
    }
  });

  it('enforces the allowlist when NODE_ENV is unset, empty or anything but development or test', () => {
    for (const nodeEnv of [undefined, '', 'staging', 'prod', 'Development', 'production']) {
      const env = { ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }), GITHUB_TOKEN: 'ghp_value' };
      expect(enforcesAllowlist(env, NO_MARKER), String(nodeEnv)).toBe(true);
      expect(() => loadExtractConfig(env, () => {}, { markerPath: NO_MARKER }), String(nodeEnv)).toThrow(/remove GITHUB_TOKEN from/);
    }
  });

  it('inside the image (marker file present), NODE_ENV=development or test cannot switch the allowlist off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crove-extract-marker-'));
    const marker = join(dir, 'crove-extract-image');
    try {
      writeFileSync(marker, 'test');
      for (const nodeEnv of ['development', 'test']) {
        const env = { NODE_ENV: nodeEnv, AI_API_KEY: 'sk-secret-value' };
        expect(enforcesAllowlist(env, marker)).toBe(true);
        expect(() => loadExtractConfig(env, () => {}, { markerPath: marker })).toThrow(/remove AI_API_KEY from/);
        expect(() => loadExtractConfig(env, () => {}, { markerPath: marker })).not.toThrow(/sk-secret-value/);
      }
      expect(IMAGE_MARKER).toBe('/etc/crove-extract-image');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts with defaults and names a bad field without its value', () => {
    expect(loadExtractConfig({ PATH: '/usr/bin', HOSTNAME: 'x' })).toMatchObject({
      PORT: 8090,
      EXTRACT_CONCURRENCY: EXTRACT_TIMING.concurrency,
      EXTRACT_MAX_QUEUE: EXTRACT_TIMING.maxQueue,
      EXTRACT_TIMEOUT_MS: EXTRACT_TIMING.parseTimeoutMs,
    });
    expect(() => loadExtractConfig({ EXTRACT_TIMEOUT_MS: 'forever' })).toThrow(/EXTRACT_TIMEOUT_MS/);
  });

  it('never lets a queued request outlast the worker: queue wait plus body read and parse fit in the client timeout', () => {
    expect(worstCaseCallMs(EXTRACT_TIMING)).toBeLessThanOrEqual(EXTRACT_CLIENT_TIMEOUT_MS);
    // Every slot ahead and the request's own counts its body read as well as its parse, then the answer.
    const { parseTimeoutMs, bodyTimeoutMs, answerSlackMs } = EXTRACT_TIMING;
    expect(worstCaseCallMs(EXTRACT_TIMING)).toBe(2 * (bodyTimeoutMs + parseTimeoutMs) + answerSlackMs);
    expect(EXTRACT_TIMING.bodyIdleTimeoutMs).toBeGreaterThan(0);
    expect(EXTRACT_TIMING.bodyIdleTimeoutMs).toBeLessThanOrEqual(bodyTimeoutMs);
    // The defaults use the whole budget: any longer parse does not fit.
    expect(() => loadExtractConfig({ EXTRACT_TIMEOUT_MS: String(parseTimeoutMs + 1) })).toThrow(/longer than the worker waits/);
    expect(() => loadExtractConfig({ EXTRACT_MAX_QUEUE: '8' })).toThrow(/longer than the worker waits/);
    expect(() => loadExtractConfig({ EXTRACT_TIMEOUT_MS: '60000' })).toThrow(/longer than the worker waits/);
    // More parsers at a time shorten the wait.
    expect(loadExtractConfig({ EXTRACT_MAX_QUEUE: '2', EXTRACT_CONCURRENCY: '2', EXTRACT_TIMEOUT_MS: '20000' }).EXTRACT_MAX_QUEUE).toBe(2);
  });
});
