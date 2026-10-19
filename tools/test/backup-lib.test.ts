// tools/backup/lib.sh (issues #307, #351): the .env reader must see what docker compose sees, the run checks must
// catch what they claim to, and the shell's sealed size must agree with seal.mjs.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { keyId, sealedSize } from '../backup/seal.mjs';

const lib = resolve(import.meta.dirname, '../backup/lib.sh').replaceAll('\\', '/');
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'crove-backup-lib-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function bash(script: string, env: Record<string, string> = {}, input = '') {
  const res = spawnSync('bash', ['-c', `. '${lib}'; ${script}`], { encoding: 'utf8', input, env: { PATH: process.env['PATH'] ?? '', ...env } });
  return { status: res.status, out: res.stdout, err: res.stderr };
}

// Each line and the value `docker compose config` resolves for it (checked with Docker Compose v2 on 2026-10-20).
const CASES: Array<[line: string, key: string, value: string]> = [
  ['A=plain', 'A', 'plain'],
  ['export B=exported', 'B', 'exported'],
  ['C=value # inline comment', 'C', 'value'],
  ['D=value#nocomment', 'D', 'value#nocomment'],
  ["E='single $A # not comment'", 'E', 'single $A # not comment'],
  ['F="double $A \\"q\\" \\\\ back"', 'F', 'double plain "q" \\ back'],
  ['G="esc \\$A literal"', 'G', 'esc $A literal'],
  ['H=${A}-braced', 'H', 'plain-braced'],
  ['I=${MISSING:-dflt}', 'I', 'dflt'],
  ['J=${MISSING-dflt2}', 'J', 'dflt2'],
  ['K=${EMPTY:-dflt3}', 'K', 'dflt3'],
  ['EMPTY=', 'EMPTY', ''],
  ['L=${EMPTY-dflt4}', 'L', ''],
  ['M=$$A', 'M', '$A'],
  ['N="line\\nbreak"', 'N', 'line\nbreak'],
  ["O='a\\nb'", 'O', 'a\\nb'],
  ['P=  spaced  ', 'P', 'spaced'],
  ['Q="trail" # c', 'Q', 'trail'],
  ['R=a$ b', 'R', 'a$ b'],
  ['S=${A:+alt}', 'S', 'alt'],
  ['T=back\\slash', 'T', 'back\\slash'],
  ['U="tab\\tx"', 'U', 'tab\tx'],
  ["V='q # x' # comment", 'V', 'q # x'],
  ['W = spaced key', 'W', 'spaced key'],
  ['X=a=b=c', 'X', 'a=b=c'],
  ['Y=${MISSING:-${A}}', 'Y', 'plain'],
  ['Z="${A}x"', 'Z', 'plainx'],
  ['AA=${A}${A}', 'AA', 'plainplain'],
  ['AB="a\'b"', 'AB', "a'b"],
  ["AC='a\"b'", 'AC', 'a"b'],
  ['AD=#hash', 'AD', '#hash'],
  ['AE= #onlycomment', 'AE', '#onlycomment'],
  ['AF=$(touch pwned)`id`', 'AF', '$(touch pwned)`id`'],
];

// Git Bash on Windows forks slowly: each case starts bash once or twice.
describe.skipIf(!hasBash)('backup lib.sh', { timeout: 120_000 }, () => {
  it('reads .env as docker compose does', () => {
    const file = join(dir, 'compose.env').replaceAll('\\', '/');
    writeFileSync(file, `# a comment\n\n${CASES.map(([line]) => line).join('\r\n')}\n`);
    const keys = CASES.map(([, key]) => key);
    const res = bash(`cd '${dir.replaceAll('\\', '/')}' && load_env_file '${file}' && for k in ${keys.join(' ')}; do printf '%s\\0' "\${!k}"; done`);
    expect(res.err).toBe('');
    expect(res.status).toBe(0);
    const values = res.out.split('\0').slice(0, -1);
    expect(Object.fromEntries(keys.map((k, i) => [k, values[i]]))).toEqual(Object.fromEntries(CASES.map(([, k, v]) => [k, v])));
  });

  it('keeps variables already set, and expands with them', () => {
    const file = join(dir, 'override.env').replaceAll('\\', '/');
    writeFileSync(file, 'STORAGE=local\nURL=http://${HOST}:8080\n');
    const res = bash(`load_env_file '${file}' && printf '%s|%s' "$STORAGE" "$URL"`, { STORAGE: 's3', HOST: 'db' });
    expect(res.out).toBe('s3|http://db:8080');
  });

  it('fails, naming the line and the key but not the value, on what it would read differently', () => {
    const bad: Array<[string, RegExp]> = [
      ['SECRET="open-secret-value', /line 1 \(SECRET\): unclosed double quote/],
      ["SECRET='open-secret-value", /line 1 \(SECRET\): unclosed single quote/],
      ['SECRET="secret-value" trailing', /line 1 \(SECRET\): text after the closing quote/],
      ['SECRET=${NEEDED:?set it}', /line 1 \(SECRET\): NEEDED is required: set it/],
      ['SECRET=${1abc}', /line 1 \(SECRET\): \$\{1abc\} is not a variable reference/],
    ];
    for (const [line, message] of bad) {
      const file = join(dir, 'bad.env').replaceAll('\\', '/');
      writeFileSync(file, `${line}\n`);
      const res = bash(`load_env_file '${file}'`);
      expect(res.status, line).toBe(1);
      expect(res.err, line).toMatch(message);
      expect(res.err, line).not.toContain('secret-value');
    }
  });

  it('agrees with seal.mjs on the key id, as base64 or hex, and refuses other keys', () => {
    const keys = [randomBytes(32), Buffer.alloc(32, 0), Buffer.from('00ff'.repeat(16), 'hex')];
    const forms = keys.flatMap((k) => [k.toString('base64'), k.toString('hex'), k.toString('hex').toUpperCase()]);
    const res = bash(`for k in ${forms.map((f) => `'${f}'`).join(' ')}; do backup_key_id "$k"; done`);
    expect(res.out.trim().split('\n')).toEqual(keys.flatMap((k) => Array(3).fill(keyId(k).toString('hex'))));
    for (const bad of ['change-me', randomBytes(16).toString('base64'), `${randomBytes(32).toString('hex')}00`, 'A'.repeat(43) + 'B']) {
      expect(bash(`backup_key_id '${bad}'`).status, bad).toBe(1);
    }
  });

  it('agrees with seal.mjs on the sealed size', () => {
    const sizes = [0, 1, 65535, 65536, 65537, 1_000_000];
    const res = bash(`for n in ${sizes.join(' ')}; do sealed_size "$n"; done`);
    expect(res.out.trim().split('\n').map(Number)).toEqual(sizes.map((n) => sealedSize(n)));
  });

  it('reports blobs whose name is not their sha256, and missing meta.env keys', () => {
    const good = 'a'.repeat(64);
    const listing = `${good}  ./org/o1/${good}\n${good}  ./org/o1/${'b'.repeat(64)}\n${good}  ./export/x\n`;
    expect(bash('content_address_mismatches', {}, listing).out).toBe(`./org/o1/${'b'.repeat(64)}\n`);
    const meta = join(dir, 'meta.env').replaceAll('\\', '/');
    writeFileSync(meta, 'RUN_ID=20261020T020000Z\nSTORAGE=s3\n');
    expect(bash(`meta_value STORAGE '${meta}'`).out).toBe('s3');
    const missing = bash(`meta_value SCHEMA_VERSION '${meta}'`);
    expect(missing.status).toBe(1);
    expect(missing.err).toContain('meta.env has no SCHEMA_VERSION');
  });
});
