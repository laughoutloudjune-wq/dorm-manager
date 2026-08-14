-- Declining a payment slip during verification.
--
-- Rejections deliberately do NOT go into invoices.payment_history: that array is
-- the record of money actually received, and it drives isPaymentOnTime()
-- (lib/points-ledger.ts), the receipt's payment date, and the ledger's
-- allocation logic. A rejected slip is the opposite of a payment, so it gets its
-- own append-only column instead of polluting one that several money paths read.
--
-- Each element: { rejected_at, reason, reviewed_by, slip_url, slip_uploaded_at }
-- slip_url is kept so the image that was turned down stays auditable even after
-- the invoice's own slip_url is cleared for re-upload.

alter table invoices
  add column if not exists slip_rejections jsonb not null default '[]'::jsonb;

comment on column invoices.slip_rejections is
  'Append-only log of payment slips an admin declined during verification. Never contains accepted payments — see payment_history for those.';
