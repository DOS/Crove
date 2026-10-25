-- Crove CRM: the crm.scheduler agent template (issue #1434, plan docs/plan/calendar.md §1 "Later", ADR-0029).
-- Idempotent.
--
-- A template is data (ADR-0029: templates are data); its program is code in modules/crm/src/agent.ts, wired into the
-- worker by key. It subscribes to crm.booking.cancelled: a booking the visitor cancelled gives the agent a task (from
-- the event's agent_task), for which it looks up the next free slots of the booking's type and hosts, comments them
-- and hands the task to the nearest human, who may invite the client again. Its ceiling is R1: it comments on and
-- hands on tasks, and never books, mails or changes a booking.
SET LOCAL lock_timeout = '2s';

-- migration-lint: cross-module the template row lives in the kernel's global agent_template table, as social.content_manager's does (#799).
INSERT INTO crove_kernel.agent_template (key, module, title, role_key, max_risk, job_description, subscribes, daily_run_cap)
VALUES (
  'crm.scheduler', 'crm', 'Điều phối lịch hẹn (AI)', 'crm.scheduler', 'R1',
  '{"responsibilities": ["Khi khách tự hủy lịch hẹn, tìm các giờ trống gần nhất của loại lịch hẹn đó", "Ghi các giờ trống vào việc và chuyển cho người phụ trách để mời khách đặt lại"], "kpis": ["Lịch hẹn khách hủy được xem trong ngày"], "workingHours": "always", "limits": ["Không đặt, không đổi, không hủy lịch hẹn và không gửi thư: việc liên hệ khách do người phụ trách quyết định"]}'::jsonb,
  ARRAY['crm.booking.cancelled'], 100)
ON CONFLICT (key) DO UPDATE SET
  module = EXCLUDED.module, title = EXCLUDED.title, role_key = EXCLUDED.role_key, max_risk = EXCLUDED.max_risk,
  job_description = EXCLUDED.job_description, subscribes = EXCLUDED.subscribes, daily_run_cap = EXCLUDED.daily_run_cap;
