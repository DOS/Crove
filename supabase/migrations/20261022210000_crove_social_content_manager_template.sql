-- Crove Social: the social.content_manager agent template (issue #799, Social plan line 19, ADR-0029). Idempotent.
--
-- A template is data (ADR-0029: templates are data); its program is code in modules/social/src/agent.ts, wired into
-- the worker by key. It subscribes to social.post.submitted: each post sent for review gives the agent a task (from
-- the event's agent_task), which it pre-reviews with deterministic checks and escalates to the nearest human. Its
-- ceiling is R1: it comments on and hands on tasks, and never approves, publishes or edits a post.
SET LOCAL lock_timeout = '2s';

INSERT INTO crove_kernel.agent_template (key, module, title, role_key, max_risk, job_description, subscribes, daily_run_cap)
VALUES (
  'social.content_manager', 'social', 'Quản lý nội dung (AI)', 'social.content_manager', 'R1',
  '{"responsibilities": ["Rà soát trước các bài gửi duyệt: lỗi theo yêu cầu của từng nền tảng, từ nên tránh theo giọng thương hiệu, ảnh chưa có mô tả", "Ghi nhận kết quả và chuyển cho người duyệt"], "kpis": ["Bài gửi duyệt được rà soát trong ngày"], "workingHours": "always", "limits": ["Không duyệt, không đăng và không sửa bài: việc duyệt và đăng do người có quyền thực hiện"]}'::jsonb,
  ARRAY['social.post.submitted'], 100)
ON CONFLICT (key) DO UPDATE SET
  module = EXCLUDED.module, title = EXCLUDED.title, role_key = EXCLUDED.role_key, max_risk = EXCLUDED.max_risk,
  job_description = EXCLUDED.job_description, subscribes = EXCLUDED.subscribes, daily_run_cap = EXCLUDED.daily_run_cap;
