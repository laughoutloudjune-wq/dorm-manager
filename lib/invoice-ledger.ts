import type { SupabaseClient } from "@supabase/supabase-js";

export const OPEN_INVOICE_STATUSES = ["pending", "partial", "overdue", "verifying"] as const;

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
};

type SyncLedgerOptions = {
  invoiceIds?: string[];
  tenantIds?: string[];
  beforeStartDate?: string;
};

type ApplyPaymentOptions = {
  invoiceId: string;
  amount: number;
  paidAt: string;
  slipUrl?: string | null;
  mode?: string;
  source?: string;
};

const toNumber = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const toDateOnly = (value: string) => {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
};

const dayDiffInclusive = (left: Date, right: Date) => {
  const leftUtc = Date.UTC(left.getFullYear(), left.getMonth(), left.getDate());
  const rightUtc = Date.UTC(right.getFullYear(), right.getMonth(), right.getDate());
  return Math.floor((rightUtc - leftUtc) / 86400000) + 1;
};

export const getInvoiceOutstanding = (invoice: Pick<InvoiceLike, "total_amount" | "paid_amount">) =>
  Math.max(0, toNumber(invoice.total_amount) - toNumber(invoice.paid_amount));

export const calculateLateFeeAmount = (
  invoice: Pick<InvoiceLike, "late_fee_start_date" | "late_fee_per_day">,
  asOfDateText: string
) => {
  if (!invoice.late_fee_start_date) return 0;
  const rate = Math.max(0, toNumber(invoice.late_fee_per_day));
  if (rate <= 0) return 0;
  const startDate = toDateOnly(invoice.late_fee_start_date);
  const asOfDate = toDateOnly(asOfDateText);
  if (asOfDate < startDate) return 0;
  return dayDiffInclusive(startDate, asOfDate) * rate;
};

export const resolveInvoiceStatus = (
  invoice: Pick<InvoiceLike, "total_amount" | "paid_amount" | "due_date">,
  asOfDateText: string
) => {
  const outstanding = getInvoiceOutstanding(invoice);
  if (outstanding <= 0) return "paid";
  const paidAmount = toNumber(invoice.paid_amount);
  if (invoice.due_date && toDateOnly(asOfDateText) > toDateOnly(invoice.due_date)) {
    return paidAmount > 0 ? "partial" : "overdue";
  }
  return paidAmount > 0 ? "partial" : "pending";
};

export async function syncInvoiceLedger(
  supabase: SupabaseClient,
  options: SyncLedgerOptions = {}
) {
  let query = supabase
    .from("invoices")
    .select(
      "id,tenant_id,total_amount,paid_amount,status,payment_history,slip_url,slip_uploaded_at,late_fee_amount,late_fee_per_day,late_fee_start_date,due_date,start_date"
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
    const nextLateFee = calculateLateFeeAmount(invoice, todayText);
    const currentLateFee = toNumber(invoice.late_fee_amount);
    const baseTotal = Math.max(0, toNumber(invoice.total_amount) - currentLateFee);
    const nextTotal = baseTotal + nextLateFee;
    const nextStatus = resolveInvoiceStatus(
      {
        total_amount: nextTotal,
        paid_amount: invoice.paid_amount,
        due_date: invoice.due_date ?? null,
      },
      todayText
    );

    if (
      Math.abs(nextLateFee - currentLateFee) < 0.0001 &&
      Math.abs(nextTotal - toNumber(invoice.total_amount)) < 0.0001 &&
      nextStatus === String(invoice.status ?? "")
    ) {
      continue;
    }

    const { error: updateError } = await supabase
      .from("invoices")
      .update({
        late_fee_amount: nextLateFee,
        total_amount: nextTotal,
        status: nextStatus,
      })
      .eq("id", invoice.id);
    if (updateError) throw new Error(updateError.message);
    updatedIds.push(invoice.id);
  }

  return { updatedIds };
}

export async function getCarryForwardCandidates(
  supabase: SupabaseClient,
  tenantId: string,
  beforeStartDate: string
) {
  await syncInvoiceLedger(supabase, { tenantIds: [tenantId], beforeStartDate });

  const { data: invoices, error } = await supabase
    .from("invoices")
    .select(
      "id,tenant_id,start_date,due_date,total_amount,paid_amount,status,late_fee_amount,late_fee_per_day,late_fee_start_date"
    )
    .eq("tenant_id", tenantId)
    .lt("start_date", beforeStartDate)
    .in("status", [...OPEN_INVOICE_STATUSES])
    .order("start_date", { ascending: true });
  if (error) throw new Error(error.message);

  const candidateIds = (invoices ?? []).map((row: any) => String(row.id));
  if (candidateIds.length === 0) return [];

  const { data: existingCarryRows, error: carryError } = await supabase
    .from("invoice_carry_forwards")
    .select("source_invoice_id")
    .in("source_invoice_id", candidateIds);
  if (carryError) throw new Error(carryError.message);

  const carriedIds = new Set((existingCarryRows ?? []).map((row: any) => String(row.source_invoice_id)));
  return (invoices ?? [])
    .filter((row: any) => !carriedIds.has(String(row.id)))
    .map((row: any) => ({
      ...row,
      outstanding_amount: getInvoiceOutstanding(row),
    }))
    .filter((row: any) => row.outstanding_amount > 0);
}

export async function applyInvoicePaymentAllocation(
  supabase: SupabaseClient,
  options: ApplyPaymentOptions
) {
  const { invoiceId, amount, paidAt, slipUrl = null, mode = "full", source = "admin" } = options;
  const safeAmount = Math.max(0, toNumber(amount));
  if (safeAmount <= 0) {
    throw new Error("Payment amount must be greater than zero.");
  }

  const { data: targetInvoice, error: targetError } = await supabase
    .from("invoices")
    .select(
      "id,tenant_id,total_amount,paid_amount,status,payment_history,slip_url,slip_uploaded_at,late_fee_amount,late_fee_per_day,late_fee_start_date,due_date"
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

  const sourceInvoiceIds = (carryRows ?? []).map((row: any) => String(row.source_invoice_id));
  if (sourceInvoiceIds.length > 0) {
    await syncInvoiceLedger(supabase, { invoiceIds: sourceInvoiceIds });
  }

  const paymentTargets: any[] = [];
  if (sourceInvoiceIds.length > 0) {
    const { data: sourceInvoices, error: sourceError } = await supabase
      .from("invoices")
      .select(
        "id,tenant_id,total_amount,paid_amount,status,payment_history,slip_url,slip_uploaded_at,late_fee_amount,late_fee_per_day,late_fee_start_date,due_date,start_date"
      )
      .in("id", sourceInvoiceIds)
      .order("start_date", { ascending: true });
    if (sourceError) throw new Error(sourceError.message);
    paymentTargets.push(...(sourceInvoices ?? []));
  }

  const { data: freshTargetInvoice, error: refreshError } = await supabase
    .from("invoices")
    .select(
      "id,tenant_id,total_amount,paid_amount,status,payment_history,slip_url,slip_uploaded_at,late_fee_amount,late_fee_per_day,late_fee_start_date,due_date,start_date"
    )
    .eq("id", invoiceId)
    .single();
  if (refreshError || !freshTargetInvoice) {
    throw new Error(refreshError?.message ?? "Invoice not found after sync.");
  }
  paymentTargets.push(freshTargetInvoice);

  const totalOutstanding = paymentTargets.reduce(
    (sum, invoice) => sum + getInvoiceOutstanding(invoice as InvoiceLike),
    0
  );
  if (totalOutstanding <= 0) {
    throw new Error("This invoice chain is already fully paid.");
  }

  const amountToAllocate = Math.min(safeAmount, totalOutstanding);
  const paymentBatchId = crypto.randomUUID();
  let remaining = amountToAllocate;
  const updates: { invoiceId: string; paid_amount: number; status: string; payment_history: any[] }[] = [];
  const allocationRows: any[] = [];

  for (const invoice of paymentTargets) {
    const outstanding = getInvoiceOutstanding(invoice as InvoiceLike);
    if (outstanding <= 0 || remaining <= 0) continue;

    const allocated = Math.min(outstanding, remaining);
    const nextPaidAmount = Math.min(toNumber(invoice.total_amount), toNumber(invoice.paid_amount) + allocated);
    const paymentHistory = Array.isArray(invoice.payment_history) ? invoice.payment_history : [];
    const paymentEntry = {
      amount: allocated,
      mode,
      paid_at: paidAt,
      slip_url: slipUrl,
      created_at: new Date().toISOString(),
      source,
      payment_batch_id: paymentBatchId,
      trigger_invoice_id: invoiceId,
    };
    const nextStatus = resolveInvoiceStatus(
      { total_amount: invoice.total_amount, paid_amount: nextPaidAmount, due_date: invoice.due_date },
      paidAt.slice(0, 10)
    );

    updates.push({
      invoiceId: String(invoice.id),
      paid_amount: nextPaidAmount,
      status: nextStatus,
      payment_history: [...paymentHistory, paymentEntry],
    });

    allocationRows.push({
      payment_batch_id: paymentBatchId,
      trigger_invoice_id: invoiceId,
      invoice_id: invoice.id,
      amount: allocated,
      paid_at: paidAt,
      slip_url: slipUrl,
      source,
      created_at: new Date().toISOString(),
    });

    remaining -= allocated;
  }

  for (const update of updates) {
    const { error: updateError } = await supabase
      .from("invoices")
      .update({
        paid_amount: update.paid_amount,
        payment_history: update.payment_history,
        slip_url: slipUrl,
        slip_uploaded_at: slipUrl ? paidAt : null,
        status: update.status,
      })
      .eq("id", update.invoiceId);
    if (updateError) throw new Error(updateError.message);
  }

  if (allocationRows.length > 0) {
    const { error: allocationError } = await supabase
      .from("invoice_payment_allocations")
      .insert(allocationRows);
    if (allocationError) throw new Error(allocationError.message);
  }

  const updatedInvoiceIds = updates.map((item) => item.invoiceId);
  const { data: updatedInvoices, error: updatedError } = await supabase
    .from("invoices")
    .select("id,paid_amount,status,payment_history,slip_url,slip_uploaded_at,total_amount")
    .in("id", updatedInvoiceIds);
  if (updatedError) throw new Error(updatedError.message);

  return {
    paymentBatchId,
    appliedAmount: amountToAllocate,
    updatedInvoices: updatedInvoices ?? [],
  };
}
