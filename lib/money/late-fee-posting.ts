/**
 * Late-fee posting — the database side of lib/money/late-fee-flow.ts.
 *
 * Every write goes through the SQL functions of migration 20261002000800
 * (post_late_fee_charge / waive_late_fee / reverse_late_fee_waiver /
 * create_late_fee_policy), which lock the target invoice and re-check the
 * numbers. Nothing here updates invoice columns directly.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  canAutoPost,
  computeLateFeeProposal,
  fullyPaidDate,
  lateFeeMode,
  pickTargetInvoice,
  policyForInvoice,
  principalOverdue,
  rowMatchesEngine,
  shiftLateFeeLineColumns,
  type FlowInvoice,
  type LateFeeChargeRow,
  type LateFeeMode,
  type LateFeePolicyRow,
  type LateFeeProposal,
} from "@/lib/money/late-fee-flow";

export const FLOW_INVOICE_SELECT =
  "id,tenant_id,room_id,status,start_date,due_date,total_amount,paid_amount,rent_amount,water_bill,electricity_bill,common_fee,late_fee_amount,additional_fees_total,additional_fees_breakdown,carry_forward_amount,discount_amount,payment_history,slip_uploaded_at,locked_late_fee_amount,late_fee_billed_at";

const isMissingRelation = (message: string) =>
  /does not exist|schema cache|could not find the table|relation .* does not exist/i.test(message);

/**
 * Loads every policy version. `available: false` means the table is not there
 * (migration not applied) — callers then keep the legacy behaviour.
 */
export async function loadLateFeePolicies(
  supabase: SupabaseClient,
): Promise<{ available: boolean; policies: LateFeePolicyRow[] }> {
  const { data, error } = await supabase
    .from("late_fee_policies")
    .select("*")
    .order("version", { ascending: true });
  if (error) {
    if (isMissingRelation(String(error.message ?? ""))) return { available: false, policies: [] };
    throw new Error(error.message);
  }
  return { available: true, policies: (data ?? []) as LateFeePolicyRow[] };
}

/**
 * The switch the legacy automatic paths consult. Any failure to read the
 * policy table counts as "legacy", so production keeps behaving exactly as
 * before until the owner deliberately creates a policy.
 */
export async function resolveLateFeeMode(
  supabase: SupabaseClient,
): Promise<{ mode: LateFeeMode; policies: LateFeePolicyRow[] }> {
  try {
    const { available, policies } = await loadLateFeePolicies(supabase);
    if (!available) return { mode: "legacy", policies: [] };
    return { mode: lateFeeMode(policies), policies };
  } catch {
    return { mode: "legacy", policies: [] };
  }
}

/**
 * Posted late fees per SOURCE invoice, net of waivers, for the tenant
 * statement. Read-only and tolerant: any error (tables not created yet) gives
 * an empty map, so the statement falls back to its existing behaviour.
 */
export async function loadPostedLateFeesBySource(
  supabase: SupabaseClient,
  sourceInvoiceIds: string[],
): Promise<Map<string, Array<{ amount: number; waived: number; targetInvoiceId: string | null }>>> {
  const out = new Map<string, Array<{ amount: number; waived: number; targetInvoiceId: string | null }>>();
  const ids = [...new Set(sourceInvoiceIds.filter(Boolean))];
  if (ids.length === 0) return out;
  try {
    const { data: charges, error } = await supabase
      .from("late_fee_charges")
      .select("id,source_invoice_id,target_invoice_id,amount")
      .in("source_invoice_id", ids);
    if (error || !charges || charges.length === 0) return out;
    const sources = charges.map((c: any) => `late_fee_charge:${c.id}`);
    const { data: adjs, error: adjError } = await supabase.from("adjustments").select("amount,source").in("source", sources);
    if (adjError) return out;
    const waivedBySource = new Map<string, number>();
    for (const a of adjs ?? []) {
      const key = String((a as any).source);
      waivedBySource.set(key, (waivedBySource.get(key) ?? 0) + Number((a as any).amount ?? 0));
    }
    for (const c of charges as any[]) {
      const list = out.get(String(c.source_invoice_id)) ?? [];
      list.push({
        amount: Number(c.amount ?? 0),
        waived: waivedBySource.get(`late_fee_charge:${c.id}`) ?? 0,
        targetInvoiceId: c.target_invoice_id ?? null,
      });
      out.set(String(c.source_invoice_id), list);
    }
  } catch {
    return new Map();
  }
  return out;
}

export type PostLateFeeArgs = {
  source: FlowInvoice;
  target: FlowInvoice;
  proposal: LateFeeProposal;
  postedBy: string;
};

export async function postLateFeeCharge(supabase: SupabaseClient, args: PostLateFeeArgs) {
  const { source, target, proposal, postedBy } = args;
  if (!proposal.coveredFrom || !proposal.coveredTo || proposal.amount <= 0) {
    throw new Error("NOTHING_TO_POST no late fee to post for this invoice");
  }
  const payload = {
    charge: {
      source_invoice_id: source.id,
      target_invoice_id: target.id,
      covered_from: proposal.coveredFrom,
      covered_to: proposal.coveredTo,
      eligible_balance: proposal.eligibleBalance,
      rate_kind: proposal.rateKind,
      rate_value: proposal.rateValue,
      formula: proposal.formula,
      policy_version: proposal.policyVersion,
      amount: proposal.amount,
      posted_by: postedBy,
    },
    target: shiftLateFeeLineColumns(target, proposal.amount),
  };
  const { data, error } = await supabase.rpc("post_late_fee_charge", { p: payload });
  if (error) throw new Error(error.message);
  return data as { replayed: boolean; charge_id: string; amount: number; total_amount: number };
}

/**
 * Automatic posting for the paths that used to bill late fees silently
 * (autoBillUnbilledLateFees after a payment, the monthly generator). Runs ONLY
 * in approval mode and only where the governing policy has auto_post and the
 * invoice fell due after that policy existed. Everything else is left for an
 * admin on the late-fee page. Returns what it posted; never throws for a
 * single invoice — a failure just leaves that fee for the admin.
 */
export async function autoPostLateFees(
  supabase: SupabaseClient,
  args: {
    tenantId: string;
    sourceInvoiceIds: string[];
    policies: LateFeePolicyRow[];
    automationName: string;
    today: string;
    /** Only post for sources already fully paid (the "fee is fixed once paid" trigger). */
    onlyPaid?: boolean;
  },
): Promise<{ postedSourceIds: string[]; skipped: Array<{ sourceId: string; reason: string }> }> {
  const postedSourceIds: string[] = [];
  const skipped: Array<{ sourceId: string; reason: string }> = [];
  if (!args.tenantId || args.sourceInvoiceIds.length === 0) return { postedSourceIds, skipped };

  const { data: invoices, error } = await supabase
    .from("invoices")
    .select(FLOW_INVOICE_SELECT)
    .eq("tenant_id", args.tenantId);
  if (error) throw new Error(error.message);
  const all = (invoices ?? []) as unknown as FlowInvoice[];

  const { data: chargeRows, error: chargeError } = await supabase
    .from("late_fee_charges")
    .select("*")
    .in("source_invoice_id", args.sourceInvoiceIds);
  if (chargeError) throw new Error(chargeError.message);
  const charges = (chargeRows ?? []) as LateFeeChargeRow[];

  for (const sourceId of args.sourceInvoiceIds) {
    const source = all.find((i) => i.id === sourceId);
    if (!source || !source.due_date) continue;
    if (args.onlyPaid && String(source.status ?? "") !== "paid") continue;
    if (source.late_fee_billed_at) continue; // already billed by the legacy flow; never bill twice
    const policy = policyForInvoice(args.policies, source.due_date);
    if (!canAutoPost(policy, source.due_date)) {
      skipped.push({ sourceId, reason: "awaiting admin approval" });
      continue;
    }
    const isPaid = String(source.status ?? "") === "paid";
    const asOf = isPaid ? fullyPaidDate(source, args.today) : args.today;
    const ownOriginal = Math.max(0, Number(source.total_amount ?? 0) - Number(source.carry_forward_amount ?? 0));
    const proposal = computeLateFeeProposal({
      policy: policy!,
      dueDate: source.due_date,
      asOf,
      outstanding: isPaid ? 0 : principalOverdue(source),
      originalDue: ownOriginal,
      balanceDuringLateWindow: ownOriginal,
      posted: charges.filter((c) => c.source_invoice_id === sourceId),
    });
    if (proposal.amount <= 0) continue;
    // Re-read the target each time: an earlier post in this loop changed its total.
    const { data: fresh, error: freshError } = await supabase
      .from("invoices")
      .select(FLOW_INVOICE_SELECT)
      .eq("tenant_id", args.tenantId);
    if (freshError) throw new Error(freshError.message);
    const target = pickTargetInvoice(source, (fresh ?? []) as unknown as FlowInvoice[]);
    if (!target || !rowMatchesEngine(target)) {
      skipped.push({ sourceId, reason: target ? "target total disagrees with engine" : "no open later invoice" });
      continue;
    }
    try {
      await postLateFeeCharge(supabase, {
        source,
        target,
        proposal,
        postedBy: `automation:${args.automationName}`,
      });
      postedSourceIds.push(sourceId);
    } catch (e: any) {
      skipped.push({ sourceId, reason: String(e?.message ?? e) });
    }
  }
  return { postedSourceIds, skipped };
}
