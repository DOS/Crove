// The open-source credential broker (crove-local, ADR-0025 decision 2): the vault, keyed from configuration. The key
// stays outside the database: in CREDENTIAL_KEY, or in the file CREDENTIAL_KEY_FILE names (created with a fresh key
// when missing, for the all-in-one container). docs/runbooks/credential-key.md has rotation and loss.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    // wx: never overwrite a key another process wrote first.
    try {
      writeFileSync(path, `${generateVaultKey()}\n`, { flag: 'wx', mode: 0o600 });
      console.log(`[credentials] created a credential key at ${path}; back it up: losing it means reconnecting every channel`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
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
