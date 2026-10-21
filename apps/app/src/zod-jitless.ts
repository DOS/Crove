// Imported first by main.tsx, before any schema runs. Zod compiles its object validators with `new Function` when it
// may, and probes once with `Function('')` to find out. The SPA's CSP allows no eval and Trusted Types refuses a
// string as script (#681), so the probe can only fail, and the browser reports it as a CSP violation even though zod
// catches it. jitless skips the probe and uses the interpreter it would fall back to anyway.
import { config } from 'zod';

config({ jitless: true });
