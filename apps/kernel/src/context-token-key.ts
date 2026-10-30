// SPDX-License-Identifier: AGPL-3.0-only
// The context token key (#1822, ADR-0028 section 9): CROVE_CONTEXT_TOKEN_KEY wins; else the file
// CROVE_CONTEXT_TOKEN_KEY_FILE names. The migrate step creates that file with a fresh key when it is missing, then
// installs the key in the database; every other role only reads it, and has none while the file does not exist.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { contextTokenKeyBytes } from '@crove/kernel-runtime';
import { contextTokenKeyProblem, isLocalUrl, type Config } from './config.ts';
import { keyFromFile } from './key-file.ts';

export function resolveContextTokenKey(
  config: Pick<Config, 'CROVE_CONTEXT_TOKEN_KEY' | 'CROVE_CONTEXT_TOKEN_KEY_FILE' | 'PUBLIC_URL'>,
  options: { create: boolean },
): string | undefined {
  if (config.CROVE_CONTEXT_TOKEN_KEY) return config.CROVE_CONTEXT_TOKEN_KEY;
  const path = config.CROVE_CONTEXT_TOKEN_KEY_FILE;
  if (!path || (!options.create && !existsSync(path))) return undefined;
  const key = keyFromFile(
    path,
    () => randomBytes(32).toString('base64'),
    (created) => console.warn(`[context-token] created a new context token key at ${created}; the migrate step installs it in the database`),
  ).trim();
  // A file that does not hold a usable key fails here, with a message that never shows its content; on a public URL,
  // so does the test suites' key or a passphrase, as for the setting (loadConfig).
  contextTokenKeyBytes(key);
  const problem = isLocalUrl(config.PUBLIC_URL) ? null : contextTokenKeyProblem(key);
  if (problem) throw new Error(`${problem} (in CROVE_CONTEXT_TOKEN_KEY_FILE)`);
  return key;
}
