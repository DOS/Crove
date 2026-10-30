-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #1977, ADR-0017 section 1): a notification no longer keeps a copy of its subject's title or file
-- name. Idempotent; applied files stay untouched.
--
-- The approval, unreadable-file and rerouted-task notices copied the proposal's or task's title, or the file's name,
-- into crove_kernel.notification.detail, where a value the personal-data erasure redacts in the task survived. Since
-- this release they store the subject's id only, and kernel.notification.list reads the title or name from the subject
-- when it shows the notice. This drops the copies already written, where the subject is still there to read them
-- from: what the notice shows does not change. A notice whose subject is gone keeps its copy (nothing else could show
-- it, and no erasure can reach a row that is gone).
SET LOCAL lock_timeout = '2s';

UPDATE crove_kernel.notification n SET detail = n.detail - 'title'
WHERE n.detail ? 'title'
  AND (
    (n.subject_type = 'kernel.proposal' AND EXISTS (SELECT 1 FROM crove_kernel.proposal p WHERE p.org_id = n.org_id AND p.id = n.subject_id))
    OR (n.subject_type = 'kernel.task' AND EXISTS (SELECT 1 FROM crove_kernel.task t WHERE t.org_id = n.org_id AND t.id = n.subject_id))
  );

UPDATE crove_kernel.notification n SET detail = n.detail - 'filename'
WHERE n.detail ? 'filename'
  AND n.subject_type = 'kernel.file'
  AND EXISTS (SELECT 1 FROM crove_kernel.file f WHERE f.org_id = n.org_id AND f.id = n.subject_id);
