# SQL test results — final run

- Project: `rghxelkifdrpvabyxopb` (**dorm-test**, the dummy project). Never production.
- Run: 2026-10-05, each script executed verbatim (only pure `--` comment lines dropped) in a rollback-wrapped call that ends with `RAISE EXCEPTION 'RESULT:...'`. All ten returned the expected RESULT error. None blocked.
- Deployed function bodies: all 12 money functions were hash-compared with the migration files (normalized body hash) after the last SQL change and matched.
- Code state: branch `worktree-agent-a020d745d962e74cb`. Unit tests 37 files, 505 passed, 3 todo. `tsc --noEmit` clean.

| Script | PASS | FAIL | PROBE / KNOWN-GAP |
|---|---|---|---|
| 01_record_payment_batch | 39 | 0 | 0 |
| 02_void_payment_batch | 31 | 0 | 0 |
| 03_append_only_and_uniqueness | 51 | 0 | 0 |
| 04_final_settle_move_out | 21 | 0 | 0 |
| 05_points_redemption | 34 | 0 | 0 |
| 06_late_fee_actions | 33 | 0 | 0 |
| 07_carry_forward_downstream | 14 | 0 | 0 |
| 08_settlement_downstream | 5 | 0 | 0 |
| 09_late_fee_freeze | 5 (P1–P9 reported as one line, "9/9") | 0 | 0 |
| 10_refund_and_settlement_correction | 22 | 0 | 0 |

Counts for 01–05 and 06–10 are the tally of result lines returned by two separate runner agents.

## Not executed
- No screen was run in a browser (including the refunds page).
- No two-session concurrency test (lock ordering is inspected, not raced).
- Migrations were not replayed in order on a clean database; the dummy project was built incrementally.
- Nothing was run against production; production schema differences are unknown (see `docs/PRODUCTION-PRECHECKS.sql`).
- `20261002000900` is test-only and must not be applied to production.
