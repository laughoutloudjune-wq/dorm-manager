-- Meter staff must never self-activate. New sign-ups (via LIFF self-register
-- or the LINE webhook's upsert-on-first-message) now default to "pending"
-- until an admin approves them from the Meter Staff admin page (set_status
-- action in app/api/admin/line-meter-users/actions/route.ts, gated on the
-- meter.edit permission). See
-- docs/audit/2026-09-29-system-audit-detailed.md finding C3.
--
-- Note: app/api/meter-staff/register/route.ts already stops self-activating
-- explicitly (status: existing?.status ?? "pending"); this default covers the
-- other path — app/api/line/webhook-meter/route.ts upserts a brand-new LINE
-- user without specifying status at all, so whatever the column default is
-- becomes that user's status.

ALTER TABLE public.line_meter_users
  ALTER COLUMN status SET DEFAULT 'pending';
