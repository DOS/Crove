// The open-source credential broker (crove-local, ADR-0025 decision 2): the vault, keyed from configuration. The key
// stays outside the database: in CREDENTIAL_KEY, or in the file CREDENTIAL_KEY_FILE names (created with a fresh key
// when missing, for the all-in-one container). docs/runbooks/credential-key.md has rotation and loss.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CredentialVault, DomainError, generateVaultKey, parseVaultKey, type CredentialBroker } from '@crove/kernel-runtime';
import type { Config } from './config.ts';

// Without a key nothing is sealed or opened: connecting a channel answers 503.
export const noCredentialBroker: CredentialBroker = {
  id: 'none',
  seal() {
    throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
  },
  open() {
    throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
  },
};

function keyFromFile(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Written whole to a temporary file, then linked into place: a process starting at the same time (api and worker
    // in one container) sees either no file or a complete one, and a link never replaces a key another process
    // published first.
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, `${generateVaultKey()}\n`, { flag: 'wx', mode: 0o600 });
    try {
      linkSync(tmp, path);
      console.warn(
        `[credentials] created a new credential key at ${path}. If this deployment had connected channels, its key file was lost and ` +
          'every channel must be reconnected; back the key up apart from the database (docs/runbooks/credential-key.md)',
      );
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

export function createCredentialBroker(config: Pick<Config, 'CREDENTIAL_KEY' | 'CREDENTIAL_KEY_FILE' | 'CREDENTIAL_KEY_PREVIOUS'>): CredentialBroker {
  const current = config.CREDENTIAL_KEY ?? (config.CREDENTIAL_KEY_FILE ? keyFromFile(config.CREDENTIAL_KEY_FILE) : null);
  if (!current) return noCredentialBroker;
  const keys = [parseVaultKey(current)];
  if (config.CREDENTIAL_KEY_PREVIOUS) {
    const previous = parseVaultKey(config.CREDENTIAL_KEY_PREVIOUS);
    if (previous.id !== keys[0]?.id) keys.push(previous);
  }
  return new CredentialVault(keys);
}
