// Launches DBOS once against a given database and reports success or the error, then exits.
// DBOS is a per-process singleton, so the schema experiment runs this as a child process per case.
//
//   node src/launch-check.ts <systemDatabaseUrl> <runMigrations: true|false>
import { DBOS } from '@dbos-inc/dbos-sdk';
import { APP_NAME, APP_VERSION, SCHEMA } from './env.ts';

const [url, runMigrations] = process.argv.slice(2);
const probe = DBOS.registerWorkflow(async () => 2, { name: 'probe' });
DBOS.setConfig({
  name: APP_NAME,
  applicationVersion: APP_VERSION,
  systemDatabaseUrl: url!,
  systemDatabaseSchemaName: SCHEMA,
  runMigrations: runMigrations === 'true',
  logLevel: 'error',
});
try {
  await DBOS.launch();
  const handle = await DBOS.startWorkflow(probe)();
  console.log(JSON.stringify({ ok: true, result: await handle.getResult() }));
  await DBOS.shutdown();
} catch (e) {
  const err = e as Error & { code?: string };
  console.log(JSON.stringify({ ok: false, error: err.name, code: err.code, message: err.message.split('\n')[0]!.slice(0, 300) }));
  process.exit(0);
}
