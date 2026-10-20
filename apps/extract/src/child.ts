// Entry point of one parser process (see sandbox.ts for the flags it runs under). The kind comes in argv, the
// bytes on stdin; one JSON answer goes to stdout and the process exits.
import { once } from 'node:events';
import { maxRequestBytes, zExtractKind, type ExtractResponse } from '@crove/extract-contract';
import { jsonChunks } from './json-chunks.ts';
import { failure, parse } from './parse.ts';

async function readStdin(max: number): Promise<Uint8Array | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > max) return null;
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

async function main(): Promise<ExtractResponse> {
  const kind = zExtractKind.safeParse(process.argv[2]);
  if (!kind.success) return failure('bad_request', 'unknown kind');
  const bytes = await readStdin(maxRequestBytes(kind.data));
  if (!bytes) return failure('too_large', 'input is larger than allowed');
  return parse(kind.data, bytes);
}

const answer = await main().catch(() => failure('internal', 'parser process failed'));
// In pieces (json-chunks.ts), waiting for the pipe to drain between them, so the answer is never held again as one
// string, as one Buffer and in the pipe's write queue (#653: an archive at the limits peaked near 384 MB that way).
// The last piece carries the exit, so the process ends only once all of it is written.
let held = '';
for (const piece of jsonChunks(answer)) {
  if (held && !process.stdout.write(held)) await once(process.stdout, 'drain');
  held = piece;
}
process.stdout.write(held, () => process.exit(0));
