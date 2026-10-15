// Entry point of one parser process (see sandbox.ts for the flags it runs under). The kind comes in argv, the
// bytes on stdin; one JSON answer goes to stdout and the process exits.
import { maxRequestBytes, zExtractKind, type ExtractResponse } from '@crove/extract-contract';
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
process.stdout.write(JSON.stringify(answer), () => process.exit(0));
