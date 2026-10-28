// Whose a dead letter is (#1720): the org its key or group was built for and the orgId of its data, or none.
// dead-letter.db.test.ts runs the whole path on PostgreSQL.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEAD_LETTER_WORK, deadLetterOrg, type DeadLetter } from '../src/dead-letter.ts';
import { jobGroup, jobKey, keyOrg, systemJobKey } from '../src/job-keys.ts';
import { QUEUES } from '../src/jobs-schema.ts';

const orgA = '0195f0a0-0000-7000-8000-00000000000a';
const orgB = '0195f0a0-0000-7000-8000-00000000000b';

const letter = (over: Partial<DeadLetter> = {}): DeadLetter => ({
  id: randomUUID(),
  data: null,
  singletonKey: null,
  groupId: null,
  sourceName: QUEUES.portalList,
  sourceId: randomUUID(),
  sourceRetryCount: 3,
  ...over,
});

describe('keyOrg (#1720)', () => {
  it('reads back the org of a key or group of the job, and nothing else', () => {
    expect(keyOrg(jobKey(orgA, QUEUES.portalList, 'list-1'), QUEUES.portalList)).toBe(orgA);
    expect(keyOrg(jobGroup(orgB, QUEUES.extract).id, QUEUES.extract)).toBe(orgB);
    // A key of another job, a system key, a key not built by job-keys.ts.
    expect(keyOrg(jobKey(orgA, QUEUES.portalList, 'x'), QUEUES.extract)).toBeNull();
    expect(keyOrg(systemJobKey(QUEUES.inbound, 'blob'), QUEUES.inbound)).toBeNull();
    expect(keyOrg(`${orgA}`, QUEUES.portalList)).toBeNull();
    expect(keyOrg(`${orgA.toUpperCase()}:${QUEUES.portalList}:x`, QUEUES.portalList)).toBeNull();
    expect(keyOrg(null, QUEUES.portalList)).toBeNull();
    expect(keyOrg(jobKey(orgA, QUEUES.portalList, 'x'), 'not a queue')).toBeNull();
  });
});

describe('deadLetterOrg (#1720)', () => {
  it('is worked with the metadata that names its source', () => {
    // Without it every copy has no sourceName and fails as not a dead letter.
    expect(DEAD_LETTER_WORK).toMatchObject({ batchSize: 1, includeMetadata: true });
  });

  it('names the org of an org job from its key, group and data', () => {
    expect(deadLetterOrg(letter({ singletonKey: jobKey(orgA, QUEUES.portalList, 'l'), data: { orgId: orgA, listId: 'l' } }))).toEqual({ orgId: orgA });
    expect(deadLetterOrg(letter({ sourceName: QUEUES.extract, groupId: jobGroup(orgB, QUEUES.extract).id, data: { orgId: orgB } }))).toEqual({ orgId: orgB });
    // A sign-out job carries no orgId in its data; its key names the org.
    expect(deadLetterOrg(letter({ sourceName: QUEUES.signOut, singletonKey: jobKey(orgA, QUEUES.signOut, 's:local'), data: { subject: 'x' } }))).toEqual({ orgId: orgA });
    expect(deadLetterOrg(letter({ data: { orgId: orgB } }))).toEqual({ orgId: orgB });
  });

  it('names no org for a job of no org', () => {
    expect(deadLetterOrg(letter({ sourceName: QUEUES.retention }))).toEqual({ orgId: null, reason: 'system' });
    expect(deadLetterOrg(letter({ sourceName: QUEUES.inbound, singletonKey: systemJobKey(QUEUES.inbound, 'blob'), data: { blobId: 'blob' } }))).toEqual({ orgId: null, reason: 'system' });
  });

  it('names no org when the key, group and data disagree, or the data names no org id', () => {
    expect(deadLetterOrg(letter({ singletonKey: jobKey(orgA, QUEUES.portalList, 'l'), data: { orgId: orgB } }))).toEqual({ orgId: null, reason: 'conflict' });
    expect(deadLetterOrg(letter({ singletonKey: jobKey(orgA, QUEUES.portalList, 'l'), groupId: jobGroup(orgB, QUEUES.portalList).id }))).toEqual({ orgId: null, reason: 'conflict' });
    expect(deadLetterOrg(letter({ singletonKey: jobKey(orgA, QUEUES.portalList, 'l'), data: { orgId: 'system' } }))).toEqual({ orgId: null, reason: 'conflict' });
    expect(deadLetterOrg(letter({ data: { orgId: 42 } }))).toEqual({ orgId: null, reason: 'conflict' });
  });

  it('takes only copies pg-boss made', () => {
    expect(deadLetterOrg(letter({ sourceName: null, data: { orgId: orgA } }))).toEqual({ orgId: null, reason: 'no_source' });
    expect(deadLetterOrg(letter({ sourceId: null, data: { orgId: orgA } }))).toEqual({ orgId: null, reason: 'no_source' });
    expect(deadLetterOrg(letter({ sourceName: 'Not A Queue', data: { orgId: orgA } }))).toEqual({ orgId: null, reason: 'no_source' });
  });
});
