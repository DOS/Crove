// Test helper: crove-extract for kernel tests. startExtractService runs the real HTTP service on a random
// loopback port, so the worker code goes through HTTP, the sandboxed parser process and the zod-validated
// client exactly as in compose. inProcessExtract skips the port (app.fetch) but still runs the parser process.
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { createExtractApp } from '@crove/extract';
import { createExtractClient, type ExtractClient } from '@crove/extract-contract';

export async function startExtractService(): Promise<{ client: ExtractClient; url: string; stop: () => Promise<void> }> {
  const app = createExtractApp({ concurrency: 2 });
  const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => resolve({ server: s, port: info.port }));
  });
  const url = `http://127.0.0.1:${port}`;
  return {
    client: createExtractClient({ url }),
    url,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function inProcessExtract(): ExtractClient {
  const app = createExtractApp({ concurrency: 2 });
  return createExtractClient({ url: 'http://crove-extract.test', fetch: async (input, init) => app.fetch(new Request(input, init)) });
}
