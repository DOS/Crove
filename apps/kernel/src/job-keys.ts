// Every pg-boss singleton key and group id the kernel sends (plan §4.8 "Job keys", #1694): <org_id>:<job>:<key>, the
// job being the queue the key is sent to. pg-boss dedupes a stately queue, and a singletonSeconds slot, on the queue
// and the key alone, whichever org sent the job, so a key without its org lets one org's job hold back or swallow
// another org's. The org is a UUID and a queue name has no colon, so a key reads back one way only: two orgs never
// build the same key, whatever logical key they pass. apps/kernel/test/job-keys.test.ts fails on a singletonKey or a
// group in apps/kernel/src not built here.
//
// A job of no org (raw inbound mail before its recipient is known, a mail provider's event) takes the scope 'system',
// which no org id can be.

const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JOB = /^[a-z][a-z0-9_-]*$/;
export const SYSTEM_SCOPE = 'system';

function build(scope: string, job: string, key: string): string {
  if (!JOB.test(job)) throw new Error('job key: the job must be a queue name');
  return `${scope}:${job}:${key}`;
}

function org(orgId: string): string {
  const id = orgId.toLowerCase();
  if (!ORG_ID.test(id)) throw new Error('job key: the org must be a UUID');
  return id;
}

/** The singleton key of an org's job: `<org_id>:<job>:<key>`. */
export function jobKey(orgId: string, job: string, key: string): string {
  return build(org(orgId), job, key);
}

/** The singleton key of a job that belongs to no org: `system:<job>:<key>`. */
export function systemJobKey(job: string, key: string): string {
  return build(SYSTEM_SCOPE, job, key);
}

/** The pg-boss group of an org's jobs on a queue: `<org_id>:<job>:org`. */
export function jobGroup(orgId: string, job: string): { id: string } {
  return { id: build(org(orgId), job, 'org') };
}
