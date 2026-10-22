// The fake tax portal as a service for the end-to-end stack (compose.e2e.yml): PORT (default 30000), HOST (default
// 0.0.0.0). Run with `node main.ts`.
import { startFakeTaxPortal } from './server.ts';

const portal = await startFakeTaxPortal({ port: Number(process.env.PORT ?? 30000), host: process.env.HOST ?? '0.0.0.0' });
console.log(`fake tax portal listening at ${portal.url}`);
