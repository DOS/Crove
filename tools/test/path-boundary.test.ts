import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ALLOWED, findViolations } from '../ci/path-boundary.mjs';

describe('G1 path boundary (#1560)', () => {
  it('names each path that belongs in crove-cloud, with the rule it breaks', () => {
    expect(
      findViolations([
        'infra/main.tf',
        'ops/prod.tfvars',
        'ops/terraform.tfstate',
        'ops/terraform.tfstate.backup',
        'ops/.terraform/providers/x',
        'ops/.terraform.lock.hcl',
        'ops/stack.tf.json',
        '.env',
        '.env.production',
        'apps/kernel/.env.local',
        'crove-cloud/README.md',
        'cloud/billing.ts',
        '.github/workflows/deploy-cloud.yml',
        '.github/workflows/release.yaml',
      ]).map((v) => [v.path, v.rule]),
    ).toEqual([
      ['infra/main.tf', 'OpenTofu or Terraform'],
      ['ops/prod.tfvars', 'OpenTofu or Terraform'],
      ['ops/terraform.tfstate', 'OpenTofu or Terraform'],
      ['ops/terraform.tfstate.backup', 'OpenTofu or Terraform'],
      ['ops/.terraform/providers/x', 'OpenTofu or Terraform'],
      ['ops/.terraform.lock.hcl', 'OpenTofu or Terraform'],
      ['ops/stack.tf.json', 'OpenTofu or Terraform'],
      ['.env', 'an environment file'],
      ['.env.production', 'an environment file'],
      ['apps/kernel/.env.local', 'an environment file'],
      ['crove-cloud/README.md', 'a Cloud-only directory'],
      ['cloud/billing.ts', 'a Cloud-only directory'],
      ['.github/workflows/deploy-cloud.yml', 'a deploy workflow'],
      ['.github/workflows/release.yaml', 'a deploy workflow'],
    ]);
  });

  it('lets examples, look-alikes and the reasoned allow list through', () => {
    expect(
      findViolations([
        '.env.example',
        'apps/web/.env.sample',
        'docs/runbooks/deploy.md',
        'tools/deploy/deploy.sh',
        'apps/kernel/src/tfa.ts',
        'docs/infra-notes.md',
        'packages/cloud-hooks/index.ts',
        '.github/workflows/ci.yml',
        '.github/workflows/deploy.yml',
      ]),
    ).toEqual([]);
    for (const entry of ALLOWED) expect(entry.reason.length, entry.path).toBeGreaterThan(10);
  });

  it('passes on the tree as it is', () => {
    const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
    expect(findViolations(paths)).toEqual([]);
  });
});
