-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #1977, ADR-0017 section 1): a notification no longer keeps a copy of its subject's title or file
-- name. Idempotent; applied files stay untouched.
--
-- The approval, unreadable-file and rerouted-task notices copied the proposal's or task's title, or the file's name,
-- into crove_kernel.notification.detail, where a value the personal-data erasure redacts in the task survived. Since
-- this release they store the subject's id only, and kernel.notification.list reads the title or name from the subject
-- when it shows the notice. This drops the copies already written by those three kinds. Where the subject is still
-- there, what the notice shows does not change; where it is gone (the org purge, a demo reset), the notice shows no
-- title, as no erasure could reach the copy and the erase result could not name it (#1977 review).
SET LOCAL lock_timeout = '2s';

UPDATE crove_kernel.notification n SET detail = n.detail - 'title' - 'filename'
WHERE n.kind IN ('kernel.approval_waiting', 'kernel.file_unreadable', 'kernel.task_rerouted')
  AND (n.detail ? 'title' OR n.detail ? 'filename');
