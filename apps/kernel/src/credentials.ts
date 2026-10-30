// The open-source credential broker (crove-local, ADR-0025 decision 2): the vault, keyed from configuration. The key
// stays outside the database: in CREDENTIAL_KEY, or in the file CREDENTIAL_KEY_FILE names (created with a fresh key
// when missing, for the all-in-one container). docs/runbooks/credential-key.md has rotation and loss.
import { CredentialVault, DomainError, generateVaultKey, parseVaultKey, type CredentialBroker } from '@crove/kernel-runtime';
import type { Config } from './config.ts';
import { keyFromFile } from './key-file.ts';

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

function credentialKeyFromFile(path: string): string {
  return keyFromFile(path, generateVaultKey, (created) =>
    console.warn(
      `[credentials] created a new credential key at ${created}. If this deployment had connected channels, its key file was lost and ` +
        'every channel must be reconnected; back the key up apart from the database (docs/runbooks/credential-key.md)',
    ),
  );
}

export function createCredentialBroker(config: Pick<Config, 'CREDENTIAL_KEY' | 'CREDENTIAL_KEY_FILE' | 'CREDENTIAL_KEY_PREVIOUS'>): CredentialBroker {
  const current = config.CREDENTIAL_KEY ?? (config.CREDENTIAL_KEY_FILE ? credentialKeyFromFile(config.CREDENTIAL_KEY_FILE) : null);
  if (!current) return noCredentialBroker;
  const keys = [parseVaultKey(current)];
  if (config.CREDENTIAL_KEY_PREVIOUS) {
    const previous = parseVaultKey(config.CREDENTIAL_KEY_PREVIOUS);
    if (previous.id !== keys[0]?.id) keys.push(previous);
  }
  return new CredentialVault(keys);
}
