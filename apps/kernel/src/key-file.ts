// SPDX-License-Identifier: AGPL-3.0-only
// A deployment key kept in a file outside the database (the all-in-one container's `keys` volume): read it, or create
// it with generate() when it is missing. Used for the credential key (ADR-0025) and the context token key (#1822).
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function keyFromFile(path: string, generate: () => string, created: (path: string) => void): string {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Written whole to a temporary file, then linked into place: a process starting at the same time (api and worker
    // in one container) sees either no file or a complete one, and a link never replaces a key another process
    // published first.
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, `${generate()}\n`, { flag: 'wx', mode: 0o600 });
    try {
      try {
        linkSync(tmp, path);
      } catch (error) {
        // A volume without hard links (some SMB, FAT or bind mounts): write in place, still never overwriting.
        if (!['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        writeFileSync(path, readFileSync(tmp), { flag: 'wx', mode: 0o600 });
      }
      created(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      unlinkSync(tmp);
    }
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Not every filesystem keeps modes (a Windows volume); reading still works.
  }
  return readFileSync(path, 'utf8');
}
