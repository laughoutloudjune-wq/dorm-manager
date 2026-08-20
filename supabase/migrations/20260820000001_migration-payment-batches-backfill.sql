-- Give every pre-existing payment_batch_id a parent row in payment_batches.
--
-- Purely derived from invoice_payment_allocations: amount is the sum of the
-- slices, and paid_at/slip/source/trigger are already identical across the rows
-- of a batch (verified before running). `payment_method_snapshot` is
-- deliberately left NULL — which account received these payments was never
-- recorded and cannot be recovered. Reporting must show those as unknown rather
-- than guess from the tenant's current account, which is the very value that has
-- been misreporting.
--
-- idempotency_key stays NULL so the partial unique index cannot collide.

WITH totals AS (
    SELECT payment_batch_id,
           sum(amount)     AS amount,
           min(paid_at)    AS paid_at,
           min(created_at) AS created_at
    FROM public.invoice_payment_allocations
    WHERE payment_batch_id IS NOT NULL
    GROUP BY payment_batch_id
),
representative AS (
    SELECT DISTINCT ON (a.payment_batch_id)
           a.payment_batch_id,
           a.trigger_invoice_id,
           a.source,
           a.slip_url,
           i.tenant_id
    FROM public.invoice_payment_allocations a
    LEFT JOIN public.invoices i ON i.id = a.invoice_id
    WHERE a.payment_batch_id IS NOT NULL
    ORDER BY a.payment_batch_id, a.created_at, a.id
)
INSERT INTO public.payment_batches (
    id, tenant_id, trigger_invoice_id, amount_received, amount_allocated,
    paid_at, source, slip_url, created_at
)
SELECT t.payment_batch_id, r.tenant_id, r.trigger_invoice_id,
       t.amount, t.amount, t.paid_at, r.source, r.slip_url, t.created_at
FROM totals t
JOIN representative r ON r.payment_batch_id = t.payment_batch_id
WHERE NOT EXISTS (
    SELECT 1 FROM public.payment_batches b WHERE b.id = t.payment_batch_id
);
