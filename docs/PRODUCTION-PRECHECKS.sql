-- PRODUCTION PRECHECKS: READ-ONLY. Every statement below is a SELECT. Nothing here changes data or schema.
-- Run each block in the Supabase SQL editor of the REAL project, BEFORE applying any migration, and keep the output.
-- It answers the questions that can only be answered against production (findings 139, 148, 149, 85, 86, 127, 179).
-- Do not paste the output into third-party tools unredacted: block 11 lists real invoice ids.

-- 1. Which database am I on? (confirm it is the production project you intend)
select current_database() as db, current_user as role_in_use, now() as at;

-- 2. Row-level security state of the tables the money system touches (finding 139: want rls_enabled = true everywhere that matters)
select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
  and c.relname in ('invoices','payment_batches','invoice_payment_allocations','invoice_carry_forwards','tenants','rooms',
                    'user_roles','point_ledger_entries','settings','payment_methods','meter_readings','move_out_requests',
                    'room_tenant_logs')
order by 1;

-- 3. Can the PUBLIC keys (anon / authenticated) write money tables directly? Any INSERT/UPDATE/DELETE row here is a risk
--    that bypasses every guard in the new functions (finding 139). Expect no rows for anon on money tables.
select grantee, table_name, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon','authenticated')
  and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
  and table_name in ('invoices','payment_batches','invoice_payment_allocations','invoice_carry_forwards','tenants','user_roles',
                     'point_ledger_entries','settings','payment_methods','room_tenant_logs','move_out_requests')
group by grantee, table_name
order by table_name, grantee;

-- 4. Any policies on those tables?
select tablename, policyname, roles, cmd
from pg_policies where schemaname = 'public'
  and tablename in ('invoices','payment_batches','invoice_payment_allocations','tenants','user_roles','point_ledger_entries')
order by tablename, policyname;

-- 5. Do functions with the names the new migrations create ALREADY exist in production? (finding 127: expect no rows)
select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('record_payment_batch','void_payment_batch','final_settle_move_out','redeem_points_atomic',
                    'reverse_points_redemption','post_late_fee_charge','waive_late_fee','reverse_late_fee_waiver',
                    'create_late_fee_policy','late_fee_engine_check','record_refund_payout','void_refund_payout',
                    'void_move_out_settlement','money_derive_invoice_status','money_derive_invoice_status_cf',
                    'money_carried_in_settled','money_downstream_ids','money_rederive_downstream','money_late_fee_amount');

-- 6. Which new tables already exist? (expect none of the 20261002 tables yet)
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('money_events','adjustments','tenant_credits','refund_payouts','late_fee_policies','late_fee_charges',
                     'move_out_settlements','payment_batches','invoice_carry_forwards','user_roles')
order by 1;

-- 7. Columns the migrations and code rely on (finding 149 / 85 / 86). Compare with docs/TEST-SCHEMA-GAPS.md.
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public' and (
      (table_name = 'tenants' and column_name in ('updated_at','forfeit_security_deposit','advance_rent_amount','security_deposit_amount','move_out_date','status','room_id'))
   or (table_name = 'invoices' and column_name in ('late_fee_billed_at','carry_forward_amount','discount_breakdown','locked_late_fee_amount','waived_late_fee_amount','payment_history','slip_url'))
   or (table_name = 'room_tenant_logs' and column_name in ('updated_at','move_out_date'))
   or (table_name = 'move_out_requests' and column_name in ('actual_move_out_date','updated_at','status'))
   or (table_name = 'payment_batches' and column_name in ('created_by','idempotency_key','payment_method_snapshot'))
   or (table_name = 'meter_readings' and column_name in ('reading_month','billing_month'))
   or (table_name = 'room_logs' and column_name in ('event_type'))
)
order by table_name, column_name;

-- 8. invoice_status enum values (the code no longer writes 'abandoned'; finding 128)
select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'invoice_status' order by e.enumsortorder;

-- 9. Distinct values in point_ledger_entries.reason (migration 0700 adds a CHECK; a value outside its list would make it fail)
select reason, count(*) from public.point_ledger_entries group by reason order by 2 desc;

-- 10. Carry-forward link health: duplicate (source,target) pairs and links across tenants (a cross-tenant link makes payments on the
--     source raise CROSS_TENANT_CARRY by design)
select 'duplicate pair' as problem, source_invoice_id, target_invoice_id, count(*) as n
from public.invoice_carry_forwards group by source_invoice_id, target_invoice_id having count(*) > 1
union all
select 'cross-tenant link', cf.source_invoice_id, cf.target_invoice_id, 1
from public.invoice_carry_forwards cf
join public.invoices s on s.id = cf.source_invoice_id
join public.invoices t on t.id = cf.target_invoice_id
where s.tenant_id is distinct from t.tenant_id;

-- 11. Legacy-shaped rows (finding 179): invoices whose paid_amount is MORE than their own charge (total - carry). Their paid_amount
--     already includes the carried part; the new rules treat them as owing total - paid. Review these by hand. Also lists
--     partially paid carry rows whose shape cannot be told apart from the new own-share shape.
select id, tenant_id, status, total_amount, carry_forward_amount, paid_amount,
       case when paid_amount > total_amount - carry_forward_amount then 'legacy-shaped (paid includes carried part)'
            else 'own-share or ambiguous (partially paid carry row)' end as shape
from public.invoices
where carry_forward_amount > 0 and paid_amount > 0 and paid_amount < total_amount
order by shape, total_amount desc;

-- 12. Paid invoices that carry a debt whose source is NOT settled (the new rule would not call these paid)
select t.id as target_id, t.status, t.total_amount, t.paid_amount, s.id as source_id, s.status as source_status, s.total_amount as source_total, s.paid_amount as source_paid
from public.invoice_carry_forwards cf
join public.invoices t on t.id = cf.target_invoice_id
join public.invoices s on s.id = cf.source_invoice_id
where t.status = 'paid' and s.status <> 'cancelled' and s.paid_amount < s.total_amount;

-- 13. Does the app's server key exist as the only writer? (informational) Extensions and roles present:
select rolname from pg_roles where rolname in ('anon','authenticated','service_role') order by 1;
