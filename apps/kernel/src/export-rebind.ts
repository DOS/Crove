// After a restore into a new bucket (issue #351, docs/runbooks/backup-and-restore.md): every restored object has a new
// version id, and tools/backup/restore.sh points each file row at it, but an org export is recorded in an audit row,
// which nothing may change. So its record still names the old versions and the export no longer downloads. This
// re-records the newest export of each org through the one write path (kernel.org.export.record, a new audit row),
// with the versions now under the same keys: the bytes are read back and must match the recorded sha256 first, so
// the export is exactly the one the owner was given. Run by restore.sh as `main.ts exports-rebind <org id>...` in the
// worker's image once migrate has run and before the worker starts.
import { BlobIntegrityError, BlobStoreAccessError, readVerified, sha256Hex, type Actor, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import type { ExportRecord } from '@crove/kernel';

const RESTORE: Actor = { type: 'system', component: 'restore' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ExportRebindDeps {
  runtime: Pick<Runtime, 'query' | 'execute'>;
  store: BlobStore;
  log?: (line: string) => void;
}

export type RebindOutcome = 'none' | 'readable' | 'rebound';

// One org: 'none' without a live export, 'readable' when every part still reads at its recorded version (the bucket
// survived, or a store without versions), 'rebound' when it was re-recorded. Throws when a blob is gone or its bytes
// differ from the recorded sha256: that export cannot be vouched for, and an owner asks for a new one.
export async function rebindExport(deps: ExportRebindDeps, orgId: string): Promise<RebindOutcome> {
  const record = await deps.runtime.query<ExportRecord | null>('kernel.org.export.current', {}, { actor: RESTORE, orgId });
  if (!record) return 'none';
  const refs = [{ key: record.manifestKey, sha256: record.manifestSha256, generation: record.manifestGeneration }, ...record.parts];
  let stale = false;
  for (const ref of refs) {
    try {
      await readVerified(deps.store, ref);
    } catch (error) {
      // Bytes that differ from the record, or a store that refuses this role, are never papered over. Anything else
      // means the recorded version is not there: a missing version, or one the new store cannot even parse (a version
      // id from another provider, which S3 answers with 400 InvalidArgument). The current object is checked below.
      if (error instanceof BlobIntegrityError || error instanceof BlobStoreAccessError) throw error;
      stale = true;
      break;
    }
  }
  if (!stale) return 'readable';

  // The version now under each key: read the current object, check its bytes, and write the same bytes again. Writes
  // are create-only, so that changes nothing and returns the generation of the object found (storage.ts, put).
  const current = async (ref: { key: string; sha256: string }): Promise<string> => {
    const bytes = await deps.store.get(ref.key);
    if (sha256Hex(bytes) !== ref.sha256) throw new BlobIntegrityError({ key: ref.key, sha256: ref.sha256, generation: null });
    return deps.store.put(ref.key, bytes, 'application/octet-stream');
  };
  const manifestGeneration = await current({ key: record.manifestKey, sha256: record.manifestSha256 });
  const parts: ExportRecord['parts'] = [];
  for (const part of record.parts) parts.push({ ...part, generation: await current(part) });
  // As a rebind: the record is checked against the export it re-records, not against today's EXPORT_TABLES (#1726). A
  // refusal (another record of the org came first, #1867) is reported for the org: the newest export then is another.
  await deps.runtime.execute('kernel.org.export.record', { ...record, manifestGeneration, parts, rebind: true }, { actor: RESTORE, orgId });
  return 'rebound';
}

// Every org given; one org's failure is reported and does not stop the others. 0 when all passed, 1 otherwise.
export async function rebindExports(deps: ExportRebindDeps, orgIds: readonly string[]): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  let failed = 0;
  for (const given of orgIds) {
    if (!UUID.test(given)) {
      log(`[exports-rebind] ${given}: not an org id`);
      failed++;
      continue;
    }
    // Storage keys and PostgreSQL's uuid text are lower case: an id typed in upper case names the same org.
    const orgId = given.toLowerCase();
    try {
      const outcome = await rebindExport(deps, orgId);
      const said = { none: 'no live export', readable: 'export reads at its recorded versions', rebound: 'export re-recorded with the restored object versions' };
      log(`[exports-rebind] org ${orgId}: ${said[outcome]}`);
    } catch (error) {
      log(`[exports-rebind] org ${orgId}: FAILED, the owner must ask for a new export: ${error instanceof Error ? error.message : String(error)}`);
      failed++;
    }
  }
  return failed === 0 ? 0 : 1;
}
