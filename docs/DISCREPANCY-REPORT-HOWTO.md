# Discrepancy report - how to run it

A read-only tool that scans the whole money ledger for historical discrepancies and writes three files. It never changes the database. You run it yourself; nobody else needs your service-role key.

## Before you run

- Warning: the output contains real tenant data (tenant ids, rooms, amounts). Do not paste it into third-party tools unredacted. Use `--redact` for anything you share.
- The service-role key bypasses RLS. The script wraps the client so only `from(...).select(...)` can run (`insert`, `update`, `upsert`, `delete`, `rpc`, auth, storage all throw), but still keep the key out of chat, tickets and screenshots.
- Prefer pointing it at a copy/branch of the database first if you have one.

## Run

```
# PowerShell
$env:DISCREPANCY_CONFIRM_READONLY = "yes"
$env:SUPABASE_URL = "https://<project>.supabase.co"     # or NEXT_PUBLIC_SUPABASE_URL
$env:SUPABASE_SERVICE_ROLE_KEY = "<service role key>"
npm install                                             # first time only (adds tsx)
npm run report:discrepancies -- --redact --out ./discrepancy-report-2026-10-03
```

(or `npx tsx scripts/discrepancy-report.ts ...`). The script prints the project host it is about to read first, so you can tell whether it is production. It refuses to run unless `DISCREPANCY_CONFIRM_READONLY` is exactly `yes`.

Flags:

- `--out <dir>`: output directory (default `./discrepancy-report-<date>/`).
- `--redact`: replace tenant identifiers with stable pseudonyms (`T-001`, `T-002`, ...; assigned in sorted id order so the same data gives the same mapping) and scrub phone-shaped text in all three files. The report itself carries tenant ids rather than names, so redaction mostly hides ids. Room ids are left in so rows can still be located by you.

## Outputs

- `findings.csv`: one row per finding (id, check, severity, amount in baht, tenant, room, invoice, batch, explanation, suggested next step).
- `summary.md`: counts and amounts per severity and per category, top rooms (by amount and by count), and an explicit list of legacy-category findings.
- `proposed-repairs.md`: one proposal per category that has findings: what would change, a SELECT you can run to preview the affected rows, the risk, and a statement that nothing has been applied.

### What "legacy" means

Findings that look like pre-ledger data are listed separately and labelled legacy: `paid_amount` with no allocation at all ("legacy, no receipt record"), batches with `amount_allocated = 0`, allocations with no account snapshot ("receiving account unknown"), and invoices with no `money_events` row. They are the expected shape of old data. They are never inferred to be missing receipts, deposits to a particular account, or refunds owed.

## Handing it to a reviewer

1. Re-run with `--redact` (do not redact by hand).
2. Send the three files from the redacted run only.
3. Keep the unredacted run to yourself; if the reviewer asks about `T-014`, look it up from your own side (the mapping is by sorted tenant id, so you can recompute it).
4. A reviewer proposes; you approve each category separately. Nothing in `proposed-repairs.md` is applied by this tool, and `proposed-repairs.md` is not a script.
