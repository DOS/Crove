// SPDX-License-Identifier: AGPL-3.0-only
// tools/deploy/compose.pilot.yml (issue #2118) against the real docker-compose.yml, read by `docker compose config`: the
// pilot layout runs api and worker apart, drops the worker's database login from the API, and keeps the all-in-one
// service behind a profile. docker-compose.yml alone must stay what `docker compose up` runs on a laptop.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../..');
// `!reset` and `!override` need compose v2.24; a runner without docker compose skips the file, as deploy.test.ts does.
const version = spawnSync('docker', ['compose', 'version', '--short'], { encoding: 'utf8' });
const [major = 0, minor = 0] = (version.status === 0 ? version.stdout.trim().replace(/^v/, '') : '0.0').split('.').map(Number);
const hasCompose = version.status === 0 && (major > 2 || (major === 2 && minor >= 24));

interface Service {
  image?: string;
  command?: string[];
  profiles?: string[];
  ports?: unknown[];
  networks?: Record<string, unknown>;
  environment?: Record<string, string | null>;
  healthcheck?: { disable?: boolean };
}

let dir: string;

function config(files: string[], env: Record<string, string> = {}, profiles: string[] = []): Record<string, Service> {
  const args = ['compose', ...files.flatMap((f) => ['-f', f]), ...profiles.flatMap((p) => ['--profile', p]), 'config', '--format', 'json'];
  const res = spawnSync('docker', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, COMPOSE_FILE: '', COMPOSE_PROFILES: '', ...env } });
  expect(res.status, res.stderr).toBe(0);
  return (JSON.parse(res.stdout) as { services: Record<string, Service> }).services;
}

describe.skipIf(!hasCompose)('compose.pilot.yml', { timeout: 60_000 }, () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'crove-pilot-compose-'));
    copyFileSync(join(repo, 'docker-compose.yml'), join(dir, 'docker-compose.yml'));
    copyFileSync(join(repo, 'tools/deploy/compose.pilot.yml'), join(dir, 'compose.pilot.yml'));
    // The release pins the images in a generated override, as deploy.sh writes it.
    writeFileSync(join(dir, 'docker-compose.override.yml'), "services:\n  crove: { image: 'registry.example/ludy@sha256:aa', build: !reset null }\n");
    writeFileSync(join(dir, '.env'), '');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('leaves docker-compose.yml alone: one crove service running every role and every module', () => {
    const services = config(['docker-compose.yml']);
    expect(services['crove']?.command).toEqual(['all']);
    expect(services['crove']?.profiles).toBeUndefined();
    expect(services['crove']?.environment?.['WORKER_DATABASE_URL']).toContain('crove_worker');
    expect(services['crove']?.environment?.['CROVE_MODULES']).toBe('');
    expect(services['api']).toBeUndefined();
    expect(services['worker']).toBeUndefined();
  });

  it('starts api and worker apart and not the all-in-one service', () => {
    const files = ['docker-compose.yml', 'docker-compose.override.yml', 'compose.pilot.yml'];
    const services = config(files, { CROVE_IMAGE: 'registry.example/ludy@sha256:bb' });
    expect(services['crove']).toBeUndefined();
    expect(services['api']?.command).toEqual(['api']);
    expect(services['worker']?.command).toEqual(['worker']);
    // The release's digest, which deploy.sh exports as CROVE_IMAGE.
    expect(services['api']?.image).toBe('registry.example/ludy@sha256:bb');
    expect(services['worker']?.image).toBe('registry.example/ludy@sha256:bb');
    // The all-in-one service is one profile away, for a laptop.
    expect(config(files, { CROVE_IMAGE: 'x' }, ['all-in-one'])['crove']?.profiles).toEqual(['all-in-one']);
  });

  it('keeps the worker database login and the sandbox away from the API', () => {
    const services = config(['docker-compose.yml', 'compose.pilot.yml']);
    const api = services['api'];
    const worker = services['worker'];
    expect(api?.environment).not.toHaveProperty('WORKER_DATABASE_URL');
    expect(api?.environment).not.toHaveProperty('EXTRACT_URL');
    expect(Object.keys(api?.networks ?? {})).toEqual(['default']);
    expect(api?.environment?.['DATABASE_URL']).toContain('crove_app');
    expect(worker?.environment?.['WORKER_DATABASE_URL']).toContain('crove_worker');
    expect(worker?.environment?.['EXTRACT_URL']).toBe('http://crove-extract:8090');
    expect(Object.keys(worker?.networks ?? {}).sort()).toEqual(['default', 'extract']);
    // Only the API opens a port.
    expect(api?.ports).toHaveLength(1);
    expect(worker?.ports).toBeUndefined();
    expect(worker?.healthcheck?.disable).toBe(true);
  });

  it('runs the finance module by default for api, worker and prober, and follows CROVE_MODULES', () => {
    const files = ['docker-compose.yml', 'compose.pilot.yml'];
    for (const [env, expected] of [
      [{}, 'finance'],
      [{ CROVE_MODULES: '' }, 'finance'],
      [{ CROVE_MODULES: 'finance,crm' }, 'finance,crm'],
    ] as const) {
      const services = config(files, env, ['prober']);
      for (const name of ['api', 'worker', 'prober']) expect(services[name]?.environment?.['CROVE_MODULES'], `${name} ${JSON.stringify(env)}`).toBe(expected);
    }
  });

  it('points the prober at the API, since crove does not run', () => {
    const prober = config(['docker-compose.yml', 'compose.pilot.yml'], {}, ['prober'])['prober'];
    expect(prober?.environment?.['PROBER_AUTH_URL']).toBe('http://api:8080/auth/v1');
    expect(config(['docker-compose.yml', 'compose.pilot.yml'], { PROBER_AUTH_URL: 'https://auth.example/auth/v1' }, ['prober'])['prober']?.environment?.['PROBER_AUTH_URL']).toBe('https://auth.example/auth/v1');
  });

  it('is the file pilot-check looks for in COMPOSE_FILE', () => {
    expect(readFileSync(join(repo, 'apps/kernel/src/pilot-check.ts'), 'utf8')).toContain("const PILOT_COMPOSE_FILE = 'compose.pilot.yml';");
  });
});
