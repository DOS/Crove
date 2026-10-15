// Runs one parse in a fresh, short-lived Node process, so a hostile file cannot outlive its request or reach
// another one. The process runs under the Node permission model with read access to the parser code only: no
// network (Node 26 denies sockets without --allow-net; the tests check it), no file writes, no child processes,
// no worker threads, no native addons. It gets an empty environment, a capped V8 heap, no code generation from
// strings, and is killed at the time limit or when the caller goes away. The heap limit does not cover Buffers,
// ArrayBuffers or wasm memory (a decompression bomb lives there), so on Linux a watchdog reads the process's
// resident memory and kills it above maxRssMb, below the container's limit.
// The permission model is not a boundary against code that has already escaped JavaScript, and the process runs
// as the same user as the server; that is why the server holds no credentials either, answers are validated by
// the worker as untrusted, and the container adds the outer limits (no egress, read-only root, no capabilities,
// 1 vCPU, 1 GiB; see docker-compose.yml).
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { EXTRACT_LIMITS, EXTRACT_TIMING, zExtractResponse, type ExtractKind, type ExtractResponse } from '@crove/extract-contract';
import { failure } from './parse.ts';

export interface SandboxOptions {
  // Wall-clock limit for one parse; the process is killed when it is reached.
  timeoutMs: number;
  // V8 old-space limit of the parser process.
  maxHeapMb: number;
  // Resident memory limit of the parser process (Linux), Buffers and wasm included. Below the container's 1 GiB.
  maxRssMb: number;
  maxOutputBytes: number;
}

export const DEFAULT_SANDBOX: SandboxOptions = {
  timeoutMs: EXTRACT_TIMING.parseTimeoutMs,
  maxHeapMb: 512,
  maxRssMb: 768,
  maxOutputBytes: EXTRACT_LIMITS.maxResponseBytes,
};

const RSS_POLL_MS = 100;

// Resident memory of a process in MB from /proc (Linux), or null where that is not available.
export async function residentMb(pid: number): Promise<number | null> {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const kb = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
    return kb === undefined ? null : Number(kb) / 1024;
  } catch {
    return null;
  }
}

// How a parser process that ended without an answer from us is reported. A kill we did not send (SIGKILL, or exit
// 137 when a shell reports it) is the kernel's OOM killer: the file needed more memory than the container has.
export function classifyExit(code: number | null, signal: NodeJS.Signals | null, stderr: string): ExtractResponse | null {
  if (/heap out of memory|allocation failed/i.test(stderr)) return failure('memory', 'parsing needed more memory than allowed');
  if (signal === 'SIGKILL' || code === 137) return failure('memory', 'parser process was killed for memory');
  if (code !== 0) return failure('internal', `parser process exited with ${signal ?? code}`);
  return null;
}

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
      clearInterval(watchdog);
      signal?.removeEventListener('abort', onAbort);
      resolve(answer);
    };
    const stop = (answer: ExtractResponse) => {
      verdict ??= answer;
      child.kill('SIGKILL');
    };

    const timer = setTimeout(() => stop(failure('timeout', `parsing took longer than ${options.timeoutMs} ms`)), options.timeoutMs);
    // Resident memory watchdog (Linux /proc). Where /proc is missing it stops at the first read; the container's
    // memory limit and classifyExit still apply.
    let polling = false;
    const watchdog = setInterval(() => {
      if (polling || child.pid === undefined || settled) return;
      polling = true;
      void residentMb(child.pid).then((mb) => {
        polling = false;
        if (mb === null) return clearInterval(watchdog);
        if (mb > options.maxRssMb) stop(failure('memory', `parsing needed more than ${options.maxRssMb} MB of memory`));
      });
    }, RSS_POLL_MS);
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
      const exit = classifyExit(code, killedBy, err);
      if (exit) return finish(exit);
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
