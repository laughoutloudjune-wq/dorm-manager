import type { SupabaseClient } from "@supabase/supabase-js";

export const OPEN_INVOICE_STATUSES = [
  "pending",
  "partial",
  "overdue",
  "verifying",
] as const;

type InvoiceLike = {
  id: string;
  tenant_id: string;
  total_amount: number | null;
  paid_amount: number | null;
  status: string | null;
  payment_history: any[] | null;
  slip_url?: string | null;
  slip_uploaded_at?: string | null;
  late_fee_amount?: number | null;
  late_fee_per_day?: number | null;
  late_fee_start_date?: string | null;
  due_date?: string | null;
  waived_late_fee_amount?: number | null;
  locked_late_fee_amount?: number | null;
  carry_forward_amount?: number | null;
};

export type SyncLedgerOptions = {
  invoiceIds?: string[];
  tenantIds?: string[];
  beforeStartDate?: string;
};

/**
 * A frozen copy of the account money was paid into. Snapshotted at payment time
 * and never re-resolved: `payment_methods` rows are edited in place and a
 * tenant's `custom_payment_method` can be re-assigned at any time, so deriving
 * the account at read time silently rewrites the history of every past month.
 */
export type PaymentMethodSnapshot = {
  type?: string | null;
  methodId?: string | null;
  label?: string | null;
  bank_name?: string | null;
  account_name?: string | null;
  account_number?: string | null;
  qr_url?: string | null;
};

export type ResolvedPaymentMethod = {
  id: string | null;
  snapshot: PaymentMethodSnapshot | null;
};

export type ApplyPaymentOptions = {
  invoiceId: string;
  amount: number;
  paidAt: string;
  slipUrl?: string | null;
  mode?: string;
  source?: string;
  /** Same key on retry returns the original allocation result (no double charge). */
  idempotencyKey?: string | null;
  /**
   * Receiving account. Omit and it is resolved from the tenant (their custom
   * account, else the default) at the moment the payment is applied.
   */
  paymentMethod?: ResolvedPaymentMethod | null;
  /** Admin user id, or `line:<userId>` for the LIFF admin. */
  createdBy?: string | null;
};

export type AllocationBreakdownRow = {
  invoiceId: string;
  allocatedAmount: number;
  newPaidAmount: number;
  newStatus: string;
};

export type ApplyPaymentResult = {
  paymentBatchId: string;
  paymentMethod?: ResolvedPaymentMethod | null;
  appliedAmount: number;
  updatedInvoices: any[];
  allocationBreakdown: AllocationBreakdownRow[];
  idempotentReplay?: boolean;
};

const toNumber = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isNaN(parsed) ? 0 : parsed;
};

export const toDateOnly = (value: string) => {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
};

export const dayDiffInclusive = (left: Date, right: Date) => {
  const leftUtc = Date.UTC(left.getFullYear(), left.getMonth(), left.getDate());
  const rightUtc = Date.UTC(
    right.getFullYear(),
    right.getMonth(),
    right.getDate(),
  );
  return Math.floor((rightUtc - leftUtc) / 86400000) + 1;
};

export const getInvoiceOutstanding = (
  invoice: Pick<InvoiceLike, "total_amount" | "paid_amount">,
) =>
  Math.max(0, toNumber(invoice.total_amount) - toNumber(invoice.paid_amount));

/**
 * How much of THIS invoice's own charge (excluding whatever it already carried in
 * from an earlier invoice) is still unpaid. Summing this across every open invoice
 * in a tenant's carry-forward chain gives the true total owed — summing raw
 * `getInvoiceOutstanding` instead double/triple-counts, since each invoice's total
 * already bundles the debt from the invoice before it.
 */
export const getInvoiceOwnOutstanding = (
  invoice: Pick<InvoiceLike, "total_amount" | "paid_amount" | "carry_forward_amount">,
) => {
  const currentOutstanding = getInvoiceOutstanding(invoice);
  const ownAmount = Math.max(
    0,
    toNumber(invoice.total_amount) - toNumber(invoice.carry_forward_amount),
  );
  return Math.max(0, Math.min(ownAmount, currentOutstanding));
};

export type AbandonCreditLine = {
  invoiceId: string;
  /** This invoice's own charge still unpaid — never its bundled total. */
  owed: number;
  applied: number;
  writtenOff: number;
  outcome: "paid" | "partial_cancelled" | "cancelled" | "already_clear";
};

export type AbandonCreditPlan = {
  lines: AbandonCreditLine[];
  creditPool: number;
  totalOwed: number;
  creditApplied: number;
  writtenOff: number;
  /** Credit left once the real debt is covered — the tenant's to get back. */
  refundableCredit: number;
};

/**
 * Work out how an abandoning tenant's deposit + advance rent lands across their
 * open invoices. Shared by the abandon API route and the move-out screen so the
 * preview an admin approves is the arithmetic that actually runs.
 *
 * Every invoice is measured by its OWN charge (`getInvoiceOwnOutstanding`).
 * Measuring by `total_amount - paid_amount` counts a carried-forward debt once
 * on the invoice that owns it and again on the invoice that carried it,
 * spending credit against money the tenant never owed.
 *
 * `invoices` must be oldest period first — credit clears the oldest debt first.
 */
export function planAbandonCredit(
  invoices: Array<
    Pick<InvoiceLike, "total_amount" | "paid_amount" | "carry_forward_amount"> & {
      id: string;
    }
  >,
  creditPool: number,
): AbandonCreditPlan {
  let remaining = Math.max(0, toNumber(creditPool));
  let totalOwed = 0;
  let creditApplied = 0;
  let writtenOff = 0;

  const lines: AbandonCreditLine[] = invoices.map((invoice) => {
    const owed = getInvoiceOwnOutstanding(invoice);
    totalOwed += owed;

    if (owed <= 0) {
      return {
        invoiceId: String(invoice.id),
        owed: 0,
        applied: 0,
        writtenOff: 0,
        outcome: "already_clear" as const,
      };
    }

    const applied = Math.min(owed, remaining);
    remaining -= applied;
    creditApplied += applied;
    const shortfall = owed - applied;
    writtenOff += shortfall;

    return {
      invoiceId: String(invoice.id),
      owed,
      applied,
      writtenOff: shortfall,
      outcome:
        shortfall <= 0
          ? ("paid" as const)
          : applied > 0
            ? ("partial_cancelled" as const)
            : ("cancelled" as const),
    };
  });

  return {
    lines,
    creditPool: Math.max(0, toNumber(creditPool)),
    totalOwed,
    creditApplied,
    writtenOff,
    refundableCredit: remaining,
  };
}

export const calculateLateFeeAmount = (
  invoice: Pick<
    InvoiceLike,
    | "late_fee_start_date"
    | "late_fee_per_day"
    | "waived_late_fee_amount"
    | "locked_late_fee_amount"
  >,
  asOfDateText: string,
) => {
  if (
    invoice.locked_late_fee_amount !== null &&
    invoice.locked_late_fee_amount !== undefined
  ) {
    return Math.max(0, toNumber(invoice.locked_late_fee_amount));
  }
  if (!invoice.late_fee_start_date) return 0;
  const rate = Math.max(0, toNumber(invoice.late_fee_per_day));
  if (rate <= 0) return 0;
  const startDate = toDateOnly(invoice.late_fee_start_date);
  const asOfDate = toDateOnly(asOfDateText);
  if (asOfDate < startDate) return 0;

  const rawLateFee = dayDiffInclusive(startDate, asOfDate) * rate;
  const waived = Math.max(0, toNumber(invoice.waived_late_fee_amount));
  return Math.max(0, rawLateFee - waived);
};

export const resolveInvoiceStatus = (
  invoice: Pick<InvoiceLike, "total_amount" | "paid_amount" | "due_date">,
  asOfDateText: string,
) => {
  const outstanding = getInvoiceOutstanding(invoice);
  if (outstanding <= 0) return "paid";
  const paidAmount = toNumber(invoice.paid_amount);
  if (
    invoice.due_date &&
    toDateOnly(asOfDateText) > toDateOnly(invoice.due_date)
  ) {
    return paidAmount > 0 ? "partial" : "overdue";
  }
  return paidAmount > 0 ? "partial" : "pending";
};

type InvoiceRowSnapshot = {
  paid_amount: number;
  payment_history: any[];
  status: string;
  slip_url: string | null;
  slip_uploaded_at: string | null;
};

/**
 * The account a tenant's money is expected to land in, right now: their assigned
 * account if they have one, otherwise the house default (the oldest
 * `payment_methods` row — the same one the tenant-facing payment page and the
 * printed invoice fall back to).
 *
 * Call this ONCE, at the moment a payment is recorded, and store what it returns.
 * Never call it to describe a payment that already happened.
 */
/** Turn a `payment_methods` row into the frozen shape stored on batches/allocations. */
export const snapshotFromPaymentMethodRow = (row: {
  id?: string | null;
  label?: string | null;
  bank_name?: string | null;
  account_name?: string | null;
  account_number?: string | null;
  qr_url?: string | null;
}): ResolvedPaymentMethod => ({
  id: row.id ? String(row.id) : null,
  snapshot: {
    type: row.qr_url ? "qr" : "bank",
    methodId: row.id ? String(row.id) : null,
    label: row.label ?? null,
    bank_name: row.bank_name ?? null,
    account_name: row.account_name ?? null,
    account_number: row.account_number ?? null,
    qr_url: row.qr_url ?? null,
  },
});

export async function resolvePaymentMethodForTenant(
  supabase: SupabaseClient,
  tenantId: string | null | undefined,
): Promise<ResolvedPaymentMethod> {
  const empty: ResolvedPaymentMethod = { id: null, snapshot: null };

  if (tenantId) {
    const { data: tenant } = await supabase
      .from("tenants")
      .select("custom_payment_method")
      .eq("id", tenantId)
      .maybeSingle();
    const custom = (tenant as any)?.custom_payment_method;
    if (custom && typeof custom === "object") {
      return {
        id: custom.methodId ? String(custom.methodId) : null,
        snapshot: custom as PaymentMethodSnapshot,
      };
    }
    // A legacy free-text method is still better than nothing — keep the label.
    if (typeof custom === "string" && custom.trim()) {
      return { id: null, snapshot: { label: custom } };
    }
  }

  const { data: fallback } = await supabase
    .from("payment_methods")
    .select("id,label,bank_name,account_name,account_number,qr_url")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!fallback) return empty;
  return snapshotFromPaymentMethodRow(fallback as any);
}

/**
 * Locate the batch a previous request with this idempotency key created.
 * `payment_batches` is the record; the `payment_history` JSON scan behind it is
 * only there so keys replayed from before the batch table existed still resolve.
 */
async function findIdempotentBatchId(
  supabase: SupabaseClient,
  triggerInvoiceId: string,
  idempotencyKey: string,
): Promise<string | null> {
  const { data: batch } = await supabase
    .from("payment_batches")
    .select("id")
    .eq("trigger_invoice_id", triggerInvoiceId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if ((batch as any)?.id) return String((batch as any).id);

  const { data: inv, error } = await supabase
    .from("invoices")
    .select("payment_history")
    .eq("id", triggerInvoiceId)
    .maybeSingle();
  if (error || !inv) return null;
  const history = Array.isArray((inv as any).payment_history)
    ? (inv as any).payment_history
    : [];
  const entry = history.find((e: any) => e?.idempotency_key === idempotencyKey);
  return entry?.payment_batch_id ? String(entry.payment_batch_id) : null;
}

async function findIdempotentPaymentResult(
  supabase: SupabaseClient,
  triggerInvoiceId: string,
  idempotencyKey: string,
): Promise<ApplyPaymentResult | null> {
  const batchId = await findIdempotentBatchId(
    supabase,
    triggerInvoiceId,
    idempotencyKey,
  );
  if (!batchId) return null;

  const { data: allocRows, error: allocError } = await supabase
    .from("invoice_payment_allocations")
    .select("invoice_id,amount,payment_method_id,payment_method_snapshot")
    .eq("payment_batch_id", batchId);
  if (allocError) return null;

  const appliedAmount = (allocRows ?? []).reduce(
    (sum, row: any) => sum + toNumber(row.amount),
    0,
  );
  const invoiceIds = [
    ...new Set((allocRows ?? []).map((r: any) => String(r.invoice_id))),
  ];
  if (invoiceIds.length === 0) return null;

  const { data: updatedInvoices, error: invError } = await supabase
    .from("invoices")
    .select(
      "id,paid_amount,status,payment_history,slip_url,slip_uploaded_at,total_amount",
    )
    .in("id", invoiceIds);
  if (invError) return null;

  const byId = new Map(
    (updatedInvoices ?? []).map((u: any) => [String(u.id), u]),
  );
  const breakdown: AllocationBreakdownRow[] = (allocRows ?? []).map(
    (row: any) => {
      const id = String(row.invoice_id);
      const inv = byId.get(id) as any;
      return {
        invoiceId: id,
        allocatedAmount: toNumber(row.amount),
        newPaidAmount: toNumber(inv?.paid_amount),
        newStatus: String(inv?.status ?? ""),
      };
    },
  );

  const replayedMethodRow = (allocRows ?? []).find(
    (row: any) => row.payment_method_snapshot || row.payment_method_id,
  ) as any;

  return {
    paymentBatchId: batchId,
    paymentMethod: replayedMethodRow
      ? {
          id: replayedMethodRow.payment_method_id
            ? String(replayedMethodRow.payment_method_id)
            : null,
          snapshot: replayedMethodRow.payment_method_snapshot ?? null,
        }
      : null,
    appliedAmount,
    updatedInvoices: updatedInvoices ?? [],
    allocationBreakdown: breakdown,
    idempotentReplay: true,
  };
}

export async function syncInvoiceLedger(
  supabase: SupabaseClient,
  options: SyncLedgerOptions = {},
) {
  let query = supabase
    .from("invoices")
    .select(
      "id,tenant_id,total_amount,paid_amount,status,payment_history,slip_url,slip_uploaded_at,late_fee_amount,late_fee_per_day,late_fee_start_date,due_date,start_date,waived_late_fee_amount,locked_late_fee_amount",
    )
    .not("status", "in", '("draft","paid","cancelled")');

  if (options.invoiceIds && options.invoiceIds.length > 0) {
    query = query.in("id", options.invoiceIds);
  }
  if (options.tenantIds && options.tenantIds.length > 0) {
    query = query.in("tenant_id", options.tenantIds);
  }
  if (options.beforeStartDate) {
    query = query.lt("start_date", options.beforeStartDate);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const todayText = new Date().toISOString().slice(0, 10);
  const rows = (data ?? []) as (InvoiceLike & { start_date?: string | null })[];
  const updatedIds: string[] = [];

  for (const invoice of rows) {
    /** Do not auto-change status while a slip is awaiting admin verification. */
    if (String(invoice.status ?? "") === "verifying") {
      continue;
    }

    // The new logic requires that the current month's invoice DOES NOT dynamically increment its late fee.
    // Late fees are only calculated at the end of the month and applied to the NEXT month's invoice as a line item.
    // Therefore, we do not update `late_fee_amount` here.

    // For status resolution, use the stored total_amount as-is.
    const nextStatus = resolveInvoiceStatus(
      {
        total_amount: invoice.total_amount,
        paid_amount: invoice.paid_amount,
        due_date: invoice.due_date ?? null,
      },
      todayText,
    );

    const updatePayload: any = {};
    if (nextStatus !== String(invoice.status ?? "")) {
      updatePayload.status = nextStatus;
      
      // If the invoice is fully paid, we lock the late fee so it doesn't get carried forward anymore.
      // We must calculate the accrued late fee up to the date it was paid.
      if (nextStatus === "paid") {
        const paymentHistory = Array.isArray(invoice.payment_history) ? invoice.payment_history : [];
        let fullyPaidAt = invoice.slip_uploaded_at ? String(invoice.slip_uploaded_at) : todayText;
        
        if (paymentHistory.length > 0) {
           const latestPayment = paymentHistory.sort((a: any, b: any) => new Date(b.paid_at || b.created_at).getTime() - new Date(a.paid_at || a.created_at).getTime())[0];
           if (latestPayment && (latestPayment.paid_at || latestPayment.created_at)) {
             fullyPaidAt = String(latestPayment.paid_at || latestPayment.created_at);
           }
        }
        
        updatePayload.locked_late_fee_amount = calculateLateFeeAmount(invoice, fullyPaidAt.slice(0, 10));
      } else if (
        nextStatus === "partial" ||
        nextStatus === "overdue" ||
        nextStatus === "pending"
      ) {
        updatePayload.locked_late_fee_amount = null;
      }
    }

    if (Object.keys(updatePayload).length > 0) {
      const { error: updateError } = await supabase
        .from("invoices")
        .update(updatePayload)
        .eq("id", invoice.id);
      if (updateError) throw new Error(updateError.message);
      updatedIds.push(invoice.id);
    }
  }

  return { updatedIds };
}

/**
 * Overdue / unpaid invoices from prior periods that can be rolled into a new invoice.
 * Each candidate is reported at its own unbundled amount (its total minus whatever it
 * already carried in from an earlier invoice), so every still-open period in the chain
 * can be listed side by side without double counting — whether or not that period was
 * previously carried into some other invoice.
 * @param valuationDateForLateFee Optional "as of" date for late-fee preview (e.g. new invoice issue_date); defaults to beforeStartDate.
 */
export async function getCarryForwardCandidatesForTarget(
  supabase: SupabaseClient,
  tenantId: string,
  beforeStartDate: string,
  targetInvoiceId?: string | null,
  valuationDateForLateFee?: string | null,
) {
  await syncInvoiceLedger(supabase, { tenantIds: [tenantId], beforeStartDate });

  const asOfLateFee = String(valuationDateForLateFee || beforeStartDate).slice(
    0,
    10,
  );

  const { data: invoices, error } = await supabase
    .from("invoices")
    .select(
      "id,tenant_id,start_date,due_date,total_amount,paid_amount,status,late_fee_amount,late_fee_per_day,late_fee_start_date,waived_late_fee_amount,locked_late_fee_amount,carry_forward_amount",
    )
    .eq("tenant_id", tenantId)
    .lt("start_date", beforeStartDate)
    .in("status", [...OPEN_INVOICE_STATUSES])
    .order("start_date", { ascending: true });
  if (error) throw new Error(error.message);

  const candidateIds = (invoices ?? []).map((row: any) => String(row.id));
  if (candidateIds.length === 0) return [];

  // Each invoice's own new charge (its total_amount minus whatever it already
  // carried in from an even earlier invoice) is a fixed amount that never overlaps
  // with a different period's own charge. So every still-open invoice in the chain
  // can be shown as its own candidate — regardless of whether it was previously
  // carried into a later invoice — without double counting, as long as we always
  // report each invoice's own portion rather than its bundled total.
  //
  // "Own portion still outstanding" has to account for partial payments too: a
  // payment on a bundled invoice pays down the total, not a specific line item, so
  // we can't know for certain whether it paid off the carried-in portion or the
  // invoice's own portion first. We assume payments retire the invoice's own charge
  // first (min of own charge vs. current outstanding) — see room 114/1 case where a
  // partial April payment left exactly its own 244 baht outstanding.
  const candidates = (invoices ?? []).map((row: any) => {
    let snapshotDays = 0;
    if (row.late_fee_start_date) {
      const startDate = toDateOnly(row.late_fee_start_date);
      const asOfDate = toDateOnly(asOfLateFee);
      if (asOfDate >= startDate) {
        snapshotDays = dayDiffInclusive(startDate, asOfDate);
      }
    }
    const snapshotLateFee = calculateLateFeeAmount(row, asOfLateFee);

    const outstanding = getInvoiceOwnOutstanding(row);

    return {
      ...row,
      outstanding_amount: outstanding,
      late_fee_snapshot_amount: snapshotLateFee,
      late_fee_snapshot_days: snapshotDays,
    };
  });

  return candidates.filter(
    (row: any) => row.outstanding_amount > 0 || row.late_fee_snapshot_amount > 0,
  );
}

export async function getCarryForwardCandidates(
  supabase: SupabaseClient,
  tenantId: string,
  beforeStartDate: string,
) {
  return getCarryForwardCandidatesForTarget(
    supabase,
    tenantId,
    beforeStartDate,
    null,
  );
}

export async function applyInvoicePaymentAllocation(
  supabase: SupabaseClient,
  options: ApplyPaymentOptions,
): Promise<ApplyPaymentResult> {
  const {
    invoiceId,
    amount,
    paidAt,
    slipUrl = null,
    mode = "full",
    source = "admin",
    idempotencyKey = null,
    paymentMethod = null,
    createdBy = null,
  } = options;
  const safeAmount = Math.max(0, toNumber(amount));
  if (safeAmount <= 0) {
    throw new Error("Payment amount must be greater than zero.");
  }

  const trimmedIdem = idempotencyKey?.trim() || null;
  if (trimmedIdem) {
    const existing = await findIdempotentPaymentResult(
      supabase,
      invoiceId,
      trimmedIdem,
    );
    if (existing) return existing;
  }

  const { data: targetInvoice, error: targetError } = await supabase
    .from("invoices")
    .select(
      "id,tenant_id,total_amount,paid_amount,status,payment_history,slip_url,slip_uploaded_at,late_fee_amount,late_fee_per_day,late_fee_start_date,due_date",
    )
    .eq("id", invoiceId)
    .single();
  if (targetError || !targetInvoice) {
    throw new Error(targetError?.message ?? "Invoice not found.");
  }

  await syncInvoiceLedger(supabase, { invoiceIds: [invoiceId] });

  const { data: carryRows, error: carryError } = await supabase
    .from("invoice_carry_forwards")
    .select("source_invoice_id,target_invoice_id")
    .eq("target_invoice_id", invoiceId);
  if (carryError) throw new Error(carryError.message);

  const sourceInvoiceIds = (carryRows ?? []).map((row: any) =>
    String(row.source_invoice_id),
  );
  if (sourceInvoiceIds.length > 0) {
    await syncInvoiceLedger(supabase, { invoiceIds: sourceInvoiceIds });
  }

  const paymentTargets: any[] = [];
  if (sourceInvoiceIds.length > 0) {
    const { data: sourceInvoices, error: sourceError } = await supabase
      .from("invoices")
      .select(
        "id,tenant_id,total_amount,paid_amount,status,payment_history,slip_url,slip_uploaded_at,late_fee_amount,late_fee_per_day,late_fee_start_date,due_date,start_date",
      )
      .in("id", sourceInvoiceIds)
      .order("start_date", { ascending: true });
    if (sourceError) throw new Error(sourceError.message);
    paymentTargets.push(...(sourceInvoices ?? []));
  }

  const { data: freshTargetInvoice, error: refreshError } = await supabase
    .from("invoices")
    .select(
      "id,tenant_id,total_amount,paid_amount,status,payment_history,slip_url,slip_uploaded_at,late_fee_amount,late_fee_per_day,late_fee_start_date,due_date,start_date",
    )
    .eq("id", invoiceId)
    .single();
  if (refreshError || !freshTargetInvoice) {
    throw new Error(refreshError?.message ?? "Invoice not found after sync.");
  }
  paymentTargets.push(freshTargetInvoice);

  // Freeze the receiving account now. Resolved from the tenant only if the
  // caller did not already resolve it — either way the value below is what gets
  // stored, and nothing downstream re-derives it.
  const resolvedMethod: ResolvedPaymentMethod =
    paymentMethod ??
    (await resolvePaymentMethodForTenant(
      supabase,
      (freshTargetInvoice as any).tenant_id,
    ));

  const totalOutstanding = paymentTargets.reduce(
    (sum, invoice) => sum + getInvoiceOutstanding(invoice as InvoiceLike),
    0,
  );
  if (totalOutstanding <= 0) {
    throw new Error("This invoice chain is already fully paid.");
  }

  const amountToAllocate = Math.min(safeAmount, totalOutstanding);
  const paymentBatchId = crypto.randomUUID();
  let remaining = amountToAllocate;
  const updates: {
    invoiceId: string;
    paid_amount: number;
    status: string;
    payment_history: any[];
    allocatedAmount: number;
  }[] = [];
  const allocationRows: any[] = [];

  const revertSnapshots = new Map<string, InvoiceRowSnapshot>();
  for (const invoice of paymentTargets) {
    const id = String(invoice.id);
    revertSnapshots.set(id, {
      paid_amount: toNumber(invoice.paid_amount),
      payment_history: Array.isArray(invoice.payment_history)
        ? invoice.payment_history
        : [],
      status: String(invoice.status ?? ""),
      slip_url: (invoice as any).slip_url ?? null,
      slip_uploaded_at: (invoice as any).slip_uploaded_at ?? null,
    });
  }

  // Bug #4 fix: Each invoice gets exactly its own allocated share.
  // No accumulation of source allocations onto the trigger invoice — that was
  // causing the trigger invoice to appear over-paid.
  for (const invoice of paymentTargets) {
    const outstanding = getInvoiceOutstanding(invoice as InvoiceLike);
    if (outstanding <= 0 || remaining <= 0) continue;

    const allocated = Math.min(outstanding, remaining);

    const nextPaidAmount = Math.min(
      toNumber(invoice.total_amount),
      toNumber(invoice.paid_amount) + allocated,
    );
    const paymentHistory = Array.isArray(invoice.payment_history)
      ? invoice.payment_history
      : [];
    const paymentEntry: Record<string, unknown> = {
      amount: allocated,
      mode,
      paid_at: paidAt,
      slip_url: slipUrl,
      created_at: new Date().toISOString(),
      source,
      payment_batch_id: paymentBatchId,
      trigger_invoice_id: invoiceId,
      // `payment_method` is what the reports read off the history entry. Before
      // this existed they fell through to the tenant's CURRENT account, so
      // re-assigning a room's account rewrote every past month's attribution.
      payment_method: resolvedMethod.snapshot,
      payment_method_id: resolvedMethod.id,
    };
    if (trimmedIdem) {
      paymentEntry.idempotency_key = trimmedIdem;
    }
    const nextStatus = resolveInvoiceStatus(
      {
        total_amount: invoice.total_amount,
        paid_amount: nextPaidAmount,
        due_date: invoice.due_date,
      },
      paidAt.slice(0, 10),
    );

    updates.push({
      invoiceId: String(invoice.id),
      paid_amount: nextPaidAmount,
      status: nextStatus,
      payment_history: [...paymentHistory, paymentEntry],
      allocatedAmount: allocated,
    });

    allocationRows.push({
      payment_batch_id: paymentBatchId,
      trigger_invoice_id: invoiceId,
      invoice_id: invoice.id,
      amount: allocated,
      paid_at: paidAt,
      slip_url: slipUrl,
      source,
      payment_method_id: resolvedMethod.id,
      payment_method_snapshot: resolvedMethod.snapshot,
      created_at: new Date().toISOString(),
    });

    remaining -= allocated;
  }

  try {
    // The batch row goes in first: it is the record of the money itself, and
    // every allocation below is a slice of it.
    const { error: batchError } = await supabase
      .from("payment_batches")
      .insert({
        id: paymentBatchId,
        tenant_id: (freshTargetInvoice as any).tenant_id ?? null,
        trigger_invoice_id: invoiceId,
        // Equal today — allocation is capped at the chain's outstanding, so a
        // caller passing a sentinel "pay everything" amount does not record a
        // fictional receipt. They diverge once overpayment is supported.
        amount_received: amountToAllocate,
        amount_allocated: amountToAllocate,
        paid_at: paidAt,
        mode,
        source,
        slip_url: slipUrl,
        payment_method_id: resolvedMethod.id,
        payment_method_snapshot: resolvedMethod.snapshot,
        idempotency_key: trimmedIdem,
        created_by: createdBy,
      });
    if (batchError) throw new Error(batchError.message);

    for (const update of updates) {
      const updatePayload: Record<string, unknown> = {
        paid_amount: update.paid_amount,
        payment_history: update.payment_history,
        status: update.status,
      };

      // `invoices.slip_url` means "a slip was submitted against THIS invoice".
      // It used to be stamped onto every invoice in the carry-forward chain with
      // the trigger payment's slip, so settling an August bill made a April
      // invoice sprout an August slip and an August timestamp — the single
      // biggest reason old invoices looked like they were being rewritten.
      // Only the invoice the payment was recorded against gets the slip; the
      // rest carry it on their payment_history entry (and on their allocation
      // row), which is where per-payment evidence belongs.
      //
      // Only ever set, never clear: passing no slip (a cash payment, an
      // abandon-room credit) must not wipe a slip the tenant already uploaded.
      if (slipUrl && update.invoiceId === invoiceId) {
        updatePayload.slip_url = slipUrl;
        updatePayload.slip_uploaded_at = paidAt;
      }

      const { error: updateError } = await supabase
        .from("invoices")
        .update(updatePayload)
        .eq("id", update.invoiceId);
      if (updateError) throw new Error(updateError.message);
    }

    if (allocationRows.length > 0) {
      const { error: allocationError } = await supabase
        .from("invoice_payment_allocations")
        .insert(allocationRows);
      if (allocationError) throw new Error(allocationError.message);
    }
  } catch (err) {
    // Unwind newest-first: allocations, then the batch, then the invoice rows.
    // Leaving a batch behind would let its idempotency key block the retry that
    // is supposed to fix this.
    const { error: allocCleanupError } = await supabase
      .from("invoice_payment_allocations")
      .delete()
      .eq("payment_batch_id", paymentBatchId);
    if (allocCleanupError) {
      console.error(
        "[invoice-ledger] Failed to clean up allocations after error:",
        paymentBatchId,
        allocCleanupError,
      );
    }
    const { error: batchCleanupError } = await supabase
      .from("payment_batches")
      .delete()
      .eq("id", paymentBatchId);
    if (batchCleanupError) {
      console.error(
        "[invoice-ledger] Failed to clean up payment batch after error:",
        paymentBatchId,
        batchCleanupError,
      );
    }

    for (const [id, snap] of revertSnapshots) {
      const { error: revertError } = await supabase
        .from("invoices")
        .update({
          paid_amount: snap.paid_amount,
          payment_history: snap.payment_history,
          status: snap.status,
          slip_url: snap.slip_url,
          slip_uploaded_at: snap.slip_uploaded_at,
        })
        .eq("id", id);
      if (revertError) {
        console.error(
          "[invoice-ledger] Failed to revert invoice after allocation error:",
          id,
          revertError,
        );
      }
    }
    throw err;
  }

  const updatedInvoiceIds = updates.map((item) => item.invoiceId);
  const { data: updatedInvoices, error: updatedError } = await supabase
    .from("invoices")
    .select(
      "id,paid_amount,status,payment_history,slip_url,slip_uploaded_at,total_amount",
    )
    .in("id", updatedInvoiceIds);
  if (updatedError) throw new Error(updatedError.message);

  const allocationBreakdown: AllocationBreakdownRow[] = updates.map((u) => ({
    invoiceId: u.invoiceId,
    allocatedAmount: u.allocatedAmount,
    newPaidAmount: u.paid_amount,
    newStatus: u.status,
  }));

  return {
    paymentBatchId,
    paymentMethod: resolvedMethod,
    appliedAmount: amountToAllocate,
    updatedInvoices: updatedInvoices ?? [],
    allocationBreakdown,
  };
}
