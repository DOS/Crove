// Detective security alert texts (issue #996): ids and counts, a pointer to the runbook. The database part is in
// security-signals.db.test.ts.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SECURITY_THRESHOLDS, securityAlertText } from '../src/security-signals.ts';

describe('security alert text', () => {
  it('names the signal with its numbers and nothing personal', () => {
    const t = DEFAULT_SECURITY_THRESHOLDS;
    expect(securityAlertText({ signal: 'actor_many_orgs', subject: 'u-1', value: 34, orgId: null, detail: 'x' }, t)).toBe(
      'user u-1 acted in 34 orgs within 5 min (threshold 20): check for cross-org probing or a stolen account (docs/runbooks/alerts.md)',
    );
    expect(securityAlertText({ signal: 'refusal_spike', subject: 'deployment', value: 900, orgId: null, detail: 'x' }, t)).toMatch(/^900 refused requests within 5 min across the deployment \(threshold 500\)/);
    expect(securityAlertText({ signal: 'privileged_grant', subject: 'a-1', value: 1, orgId: 'o-1', detail: 'owner' }, t)).toBe('owner role given in org o-1 (audit row a-1): confirm it was intended');
    expect(securityAlertText({ signal: 'privileged_grant', subject: 'a-2', value: 1, orgId: 'o-1', detail: 'anything' }, t)).toMatch(/^admin role given/);
  });
});
