// crove-extract (External-tenant gate T12): the HTTP limits, the parser process limits, what the parser process
// cannot do (network, file writes, child processes, environment) and the credential guard at startup.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXTRACT_LIMITS, zExtractResponse, type ExtractResponse } from '@crove/extract-contract';
import { credentialVariables, loadExtractConfig } from '../src/main.ts';
import { DEFAULT_SANDBOX, PARSER_ENV, parserFlags, runSandboxed } from '../src/sandbox.ts';
import { createExtractApp, type Runner } from '../src/server.ts';

const FIXTURE = readFileSync(new URL('../../../packages/l10n-vn/test/fixtures/einvoice-basic.xml', import.meta.url));
const encode = (text: string) => new TextEncoder().encode(text);

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
    expect(await answer(unknown)).toMatchObject({ code: 'bad_request' });
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

describe('crove-extract parser process isolation', () => {
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

  it('only warns about credentials outside production, still without values', () => {
    const warnings: string[] = [];
    const config = loadExtractConfig({ GITHUB_TOKEN: 'ghp_value' }, (m) => warnings.push(m));
    expect(config.PORT).toBe(8090);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/GITHUB_TOKEN/);
    expect(warnings[0]).not.toMatch(/ghp_value/);
  });

  it('starts with defaults and names a bad field without its value', () => {
    expect(loadExtractConfig({ PATH: '/usr/bin', HOSTNAME: 'x' })).toMatchObject({ PORT: 8090, EXTRACT_CONCURRENCY: 1, EXTRACT_TIMEOUT_MS: 30_000 });
    expect(() => loadExtractConfig({ EXTRACT_TIMEOUT_MS: 'forever' })).toThrow(/EXTRACT_TIMEOUT_MS/);
  });
});
