// Runs one parse in a fresh, short-lived Node process, so a hostile file cannot outlive its request or reach
// another one. The process runs under the Node permission model with read access to the parser code only: no
// network (Node 26 denies sockets without --allow-net; the tests check it), no file writes, no child processes,
// no worker threads, no native addons. It gets an empty environment, a capped V8 heap, no code generation from
// strings, and is killed at the time limit or when the caller goes away.
// The permission model is not a boundary against code that has already escaped JavaScript, and the process runs
// as the same user as the server; that is why the server holds no credentials either, answers are validated by
// the worker as untrusted, and the container adds the outer limits (no egress, read-only root, no capabilities,
// 1 vCPU, 1 GiB; see docker-compose.yml).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXTRACT_LIMITS, zExtractResponse, type ExtractKind, type ExtractResponse } from '@crove/extract-contract';
import { failure } from './parse.ts';

export interface SandboxOptions {
  // Wall-clock limit for one parse; the process is killed when it is reached.
  timeoutMs: number;
  // V8 old-space limit of the parser process.
  maxHeapMb: number;
  maxOutputBytes: number;
}

export const DEFAULT_SANDBOX: SandboxOptions = {
  timeoutMs: 30_000,
  maxHeapMb: 512,
  maxOutputBytes: EXTRACT_LIMITS.maxResponseBytes,
};

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const CHILD = at('./child.ts');
// Readable by a parser process: its own code, the two workspace packages it loads and the installed
// dependencies. Never the rest of a development checkout (.env, .data).
const READABLE = [at('../'), at('../../../packages/extract-contract/'), at('../../../packages/l10n-vn/'), at('../../../node_modules/')];
const MAX_STDERR = 16 * 1024;

// Node flags of a parser process. Exported for the tests that prove what the process cannot do.
export function parserFlags(options: SandboxOptions): string[] {
  return [
    '--permission',
    ...READABLE.map((path) => `--allow-fs-read=${path}`),
    `--max-old-space-size=${options.maxHeapMb}`,
    '--disallow-code-generation-from-strings',
    '--no-addons',
    '--disable-sigusr1',
  ];
}

// The parser process inherits nothing from this one: no variables, so no credentials even by mistake.
export const PARSER_ENV: NodeJS.ProcessEnv = {};

export function runSandboxed(
  kind: ExtractKind,
  bytes: Uint8Array,
  options: SandboxOptions = DEFAULT_SANDBOX,
  signal?: AbortSignal,
): Promise<ExtractResponse> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...parserFlags(options), CHILD, kind], {
      env: PARSER_ENV,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = '';
    let verdict: ExtractResponse | null = null;
    let settled = false;

    const onAbort = () => stop(failure('internal', 'caller went away'));
    const finish = (answer: ExtractResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(answer);
    };
    const stop = (answer: ExtractResponse) => {
      verdict ??= answer;
      child.kill('SIGKILL');
    };

    const timer = setTimeout(() => stop(failure('timeout', `parsing took longer than ${options.timeoutMs} ms`)), options.timeoutMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.byteLength;
      if (outBytes > options.maxOutputBytes) return stop(failure('invalid', 'parser answer is larger than allowed'));
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (err.length < MAX_STDERR) err += chunk.toString('utf8').slice(0, MAX_STDERR - err.length);
    });
    // The parser may exit before reading everything (for example on a bad kind); that is not an error here.
    child.stdin.on('error', () => {});
    child.on('error', () => finish(failure('internal', 'parser process could not start')));
    child.on('close', (code, killedBy) => {
      if (verdict) return finish(verdict);
      if (/heap out of memory|allocation failed/i.test(err)) return finish(failure('memory', 'parsing needed more memory than allowed'));
      // A kill we did not send, for example the container's OOM killer under load: not the file's fault, so
      // it is answered as a service failure and the worker retries.
      if (code !== 0) return finish(failure('internal', `parser process exited with ${killedBy ?? code}`));
      let json: unknown;
      try {
        json = JSON.parse(Buffer.concat(out).toString('utf8'));
      } catch {
        return finish(failure('internal', 'parser process gave no answer'));
      }
      const parsed = zExtractResponse.safeParse(json);
      finish(parsed.success ? parsed.data : failure('internal', 'parser answer failed validation'));
    });

    child.stdin.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  });
}
