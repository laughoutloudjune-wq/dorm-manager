-- These 4 policies apply with no bucket_id filter at all -- despite their
-- names, each grants public SELECT/INSERT on every bucket, not just the one
-- it's named after (finding C2, docs/audit/2026-09-29-system-audit-detailed.md).
-- The properly bucket-scoped policies (payment_slips_public_*,
-- payment_methods_public_*, tenant_docs_public_*) are untouched -- those are
-- legitimate, deliberately public flows (tenant slip upload, bank QR
-- display). tenant-docs and contracts going fully private still needs the
-- signed-URL rework the audit calls for; not done in this pass.
DROP POLICY IF EXISTS "slips upload 1t7jg3_0" ON storage.objects;
DROP POLICY IF EXISTS "slips upload 1t7jg3_1" ON storage.objects;
DROP POLICY IF EXISTS "contracts 1shn069_0" ON storage.objects;
DROP POLICY IF EXISTS "contracts 1shn069_1" ON storage.objects;
