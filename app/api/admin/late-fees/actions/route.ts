import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAdminPermission } from "@/lib/admin-api-auth";
import type { PermissionKey } from "@/lib/permissions";
import { bangkokToday } from "@/lib/money/action-queue";
import { isMissingTable } from "@/lib/money/reconciliation-loader";
import {
  buildEstimateRow,
  chargeAdjustmentSource,
  comparePolicyOnHistory,
  explainLateFeeError,
  lateFeeMode,
  parsePolicyInput,
  round2,
  shiftLateFeeLineColumns,
  summarizeCharge,
  validateWaiver,
  waiverPreview,
  OPEN_TARGET_STATUSES,
  type FlowInvoice,
  type LateFeeAdjustmentRow,
  type LateFeeChargeRow,
  type LateFeePolicyRow,
} from "@/lib/money/late-fee-flow";
import { FLOW_INVOICE_SELECT, loadLateFeePolicies, postLateFeeCharge } from "@/lib/money/late-fee-posting";

/**
 * Late-fee approval flow (migration 20261002000800).
 *
 *   get_estimates               late_fee.view     read-only
 *   preview_policy_comparison   late_fee.view     read-only; changes nothing
 *   preview_waiver              late_fee.view     read-only before/after
 *   post_fee                    late_fee.approve  post_late_fee_charge
 *   waive_fee                   late_fee.approve  waive_late_fee
 *   reverse_waiver              late_fee.approve  reverse_late_fee_waiver
 *   set_policy                  late_fee.policy   create_late_fee_policy (new version; never applied to
 *                                                 existing invoices automatically)
 *
 * The server recomputes every amount; the client only names what to act on.
 * Every write is one SQL function call that locks the target invoice.
 */

const PERMISSION_BY_ACTION: Record<string, PermissionKey> = {
  get_estimates: "late_fee.view",
  preview_policy_comparison: "late_fee.view",
  preview_waiver: "late_fee.view",
  post_fee: "late_fee.approve",
  waive_fee: "late_fee.approve",
  reverse_waiver: "late_fee.approve",
  set_policy: "late_fee.policy",
};

const KNOWN_CONFLICTS =
  /^(STALE_INVOICE|OVERLAPPING_CHARGE|DUPLICATE_CHARGE_DIFFERENT|DUPLICATE_KEY_DIFFERENT|INCONSISTENT_COLUMNS|ENGINE_MISMATCH|TARGET_NOT_OPEN|TENANT_MISMATCH|WAIVER_EXCEEDS_FEE|WAIVER_BELOW_PAID|REASON_REQUIRED|APPROVER_REQUIRED|AUTO_POST_DISABLED|AUTO_POST_HISTORICAL|CAP_EXCEEDED|AMOUNT_EXCEEDS_RATE|RATE_MISMATCH|LINE_OUT_OF_SYNC|LINE_NOT_FOUND|POLICY_NOT_EFFECTIVE|PERIOD_BEFORE_DUE|TARGET_NOT_LATER|NOTHING_TO_POST|ESTIMATE_CHANGED)/;

const one = <T,>(v: T | T[] | null | undefined): T | undefined => (Array.isArray(v) ? v[0] : v ?? undefined);
const chunks = <T,>(xs: T[], n = 200) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function selectIn<T>(supabase: SupabaseClient, table: string, columns: string, column: string, ids: string[]): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunks([...new Set(ids)])) {
    if (part.length === 0) continue;
    const { data, error } = await supabase.from(table).select(columns).in(column, part);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

async function loadChargesAndAdjustments(supabase: SupabaseClient, sourceIds: string[]) {
  const charges = await selectIn<LateFeeChargeRow>(supabase, "late_fee_charges", "*", "source_invoice_id", sourceIds);
  const adjustments = await selectIn<LateFeeAdjustmentRow>(
    supabase,
    "adjustments",
    "id,type,amount,reason,actor,source,reverses_adjustment_id,created_at",
    "source",
    charges.map((c) => chargeAdjustmentSource(c.id)),
  );
  return { charges, adjustments };
}

async function requirePolicies(supabase: SupabaseClient) {
  const { available, policies } = await loadLateFeePolicies(supabase);
  if (!available) throw new HttpError(503, "ยังไม่ได้สร้างตารางนโยบายค่าปรับในฐานข้อมูล (migration 20261002000400/0800)");
  return policies;
}

async function getInvoice(supabase: SupabaseClient, id: string): Promise<FlowInvoice> {
  const { data, error } = await supabase.from("invoices").select(FLOW_INVOICE_SELECT).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new HttpError(404, "ไม่พบใบแจ้งหนี้");
  return data as unknown as FlowInvoice;
}

async function openTenantInvoices(supabase: SupabaseClient, tenantIds: string[]) {
  const rows: FlowInvoice[] = [];
  for (const part of chunks([...new Set(tenantIds.filter(Boolean))])) {
    const { data, error } = await supabase
      .from("invoices")
      .select(FLOW_INVOICE_SELECT)
      .in("tenant_id", part)
      .in("status", [...OPEN_TARGET_STATUSES]);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as unknown as FlowInvoice[]));
  }
  return rows;
}

// ---------------------------------------------------------------------------

async function getEstimates(supabase: SupabaseClient) {
  const today = bangkokToday();
  const { available, policies } = await loadLateFeePolicies(supabase);
  const select = `${FLOW_INVOICE_SELECT},tenants(full_name),rooms(room_number)`;

  const { data: openRows, error: openError } = await supabase
    .from("invoices")
    .select(select)
    .in("status", ["pending", "partial", "overdue", "verifying"])
    .lt("due_date", today)
    .limit(5000);
  if (openError) throw new Error(openError.message);

  // Paid-late invoices whose fee was never billed, only where a policy can apply.
  let paidRows: any[] = [];
  const earliest = policies.reduce<string | null>(
    (min, p) => (!min || p.effective_from < min ? p.effective_from : min),
    null,
  );
  if (earliest) {
    const { data, error } = await supabase
      .from("invoices")
      .select(select)
      .eq("status", "paid")
      .is("late_fee_billed_at", null)
      .gte("due_date", earliest)
      .lt("due_date", today)
      .limit(5000);
    if (error) throw new Error(error.message);
    paidRows = data ?? [];
  }

  const rows = [...(openRows ?? []), ...paidRows] as any[];
  const invoices = rows.map(({ tenants: _t, rooms: _r, ...i }) => i as FlowInvoice);
  const tenantInvoices = await openTenantInvoices(
    supabase,
    invoices.map((i) => String(i.tenant_id ?? "")),
  );
  const { charges, adjustments } = available
    ? await loadChargesAndAdjustments(supabase, invoices.map((i) => i.id))
    : { charges: [], adjustments: [] };

  const estimates = rows
    .map((r) => {
      const { tenants, rooms, ...invoice } = r;
      const row = buildEstimateRow({
        invoice: invoice as FlowInvoice,
        tenantInvoices,
        policies,
        charges,
        adjustments,
        today,
      });
      return row
        ? { ...row, tenantName: one<any>(tenants)?.full_name ?? null, roomNumber: one<any>(rooms)?.room_number ?? null }
        : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  return {
    today,
    available,
    mode: available ? lateFeeMode(policies) : "legacy",
    policies: [...policies].sort((a, b) => b.version - a.version),
    estimates,
    targets: Object.fromEntries(
      tenantInvoices.map((t) => [t.id, { id: t.id, start_date: t.start_date, status: t.status, total_amount: t.total_amount, paid_amount: t.paid_amount }]),
    ),
  };
}

async function postFee(supabase: SupabaseClient, userId: string, body: any) {
  const invoiceId = String(body?.invoiceId ?? "");
  if (!invoiceId) throw new HttpError(400, "invoiceId is required");
  const policies = await requirePolicies(supabase);
  const source = await getInvoice(supabase, invoiceId);
  const tenantInvoices = await openTenantInvoices(supabase, [String(source.tenant_id ?? "")]);
  const { charges, adjustments } = await loadChargesAndAdjustments(supabase, [source.id]);
  const row = buildEstimateRow({ invoice: source, tenantInvoices, policies, charges, adjustments, today: bangkokToday() });
  if (!row || !row.estimate || row.estimate.amount <= 0) throw new HttpError(409, "NOTHING_TO_POST ไม่มีค่าปรับใหม่ให้เรียกเก็บ");
  if (row.blockedReason) throw new HttpError(409, row.blockedReason);
  // The admin approved a specific figure; if it moved since the screen loaded, ask again.
  const expected = body?.expectedAmount;
  if (expected !== undefined && round2(Number(expected)) !== row.estimate.amount) {
    throw new HttpError(409, `ESTIMATE_CHANGED ยอดประมาณการเปลี่ยนเป็น ${row.estimate.amount} บาท กรุณาโหลดใหม่แล้วอนุมัติอีกครั้ง`);
  }
  const target = tenantInvoices.find((t) => t.id === row.targetInvoiceId);
  if (!target) throw new HttpError(409, "ยังไม่มีบิลถัดไปที่เปิดแก้ไขได้");
  const result = await postLateFeeCharge(supabase, { source, target, proposal: row.estimate, postedBy: userId });
  return { result, posted: { amount: row.estimate.amount, formula: row.estimate.formula, targetInvoiceId: target.id } };
}

async function loadChargeContext(supabase: SupabaseClient, chargeId: string) {
  const { data: charge, error } = await supabase.from("late_fee_charges").select("*").eq("id", chargeId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!charge) throw new HttpError(404, "ไม่พบรายการค่าปรับ");
  const c = charge as LateFeeChargeRow;
  if (!c.target_invoice_id) throw new HttpError(409, "ค่าปรับนี้ยังไม่ได้ลงบิล");
  const { adjustments } = await loadChargesAndAdjustments(supabase, [c.source_invoice_id]);
  const target = await getInvoice(supabase, c.target_invoice_id);
  return { charge: c, summary: summarizeCharge(c, adjustments), target };
}

async function previewWaiver(supabase: SupabaseClient, body: any) {
  const { summary, target } = await loadChargeContext(supabase, String(body?.chargeId ?? ""));
  const amount = round2(Number(body?.amount ?? summary.remaining));
  return { remaining: summary.remaining, amount, ...waiverPreview(target, Math.min(amount, summary.remaining)) };
}

async function waiveFee(supabase: SupabaseClient, userId: string, body: any) {
  const chargeId = String(body?.chargeId ?? "");
  const key = String(body?.idempotencyKey ?? "").trim();
  if (!chargeId || !key) throw new HttpError(400, "chargeId and idempotencyKey are required");
  const { summary, target } = await loadChargeContext(supabase, chargeId);
  const check = validateWaiver({ amount: body?.amount, reason: body?.reason, remaining: summary.remaining });
  if (!check.ok) throw new HttpError(400, check.error);
  const { data, error } = await supabase.rpc("waive_late_fee", {
    p: {
      waiver: { charge_id: chargeId, amount: check.amount, reason: String(body.reason).trim(), approver: userId, idempotency_key: key },
      target: shiftLateFeeLineColumns(target, -check.amount),
    },
  });
  if (error) throw new Error(error.message);
  return { result: data };
}

async function reverseWaiver(supabase: SupabaseClient, userId: string, body: any) {
  const adjustmentId = String(body?.adjustmentId ?? "");
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!adjustmentId) throw new HttpError(400, "adjustmentId is required");
  if (!reason) throw new HttpError(400, "ต้องระบุเหตุผลในการยกเลิกการยกเว้น");
  const { data: adj, error } = await supabase
    .from("adjustments")
    .select("id,type,amount,source")
    .eq("id", adjustmentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!adj || (adj as any).type !== "waiver" || !String((adj as any).source ?? "").startsWith("late_fee_charge:")) {
    throw new HttpError(404, "ไม่พบรายการยกเว้นค่าปรับ");
  }
  const chargeId = String((adj as any).source).slice("late_fee_charge:".length);
  const { target } = await loadChargeContext(supabase, chargeId);
  const { data, error: rpcError } = await supabase.rpc("reverse_late_fee_waiver", {
    p: {
      reversal: { adjustment_id: adjustmentId, reason, approver: userId },
      target: shiftLateFeeLineColumns(target, Number((adj as any).amount)),
    },
  });
  if (rpcError) throw new Error(rpcError.message);
  return { result: data };
}

async function setPolicy(supabase: SupabaseClient, userId: string, body: any) {
  const parsed = parsePolicyInput(body?.policy ?? body);
  if (!parsed.ok) throw new HttpError(400, parsed.error);
  await requirePolicies(supabase);
  const { data, error } = await supabase.rpc("create_late_fee_policy", { p: { ...parsed.value, created_by: userId } });
  if (error) throw new Error(error.message);
  // Deliberately nothing else: a new policy is never applied to existing invoices here.
  return { result: data };
}

async function previewPolicyComparison(supabase: SupabaseClient, body: any) {
  const parsed = parsePolicyInput(body?.policy ?? body);
  if (!parsed.ok) throw new HttpError(400, parsed.error);
  const months = Math.min(24, Math.max(1, Number(body?.months ?? 6) || 6));
  const today = bangkokToday();
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - months * 31 * 86400000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("invoices")
    .select(FLOW_INVOICE_SELECT)
    .gte("due_date", since)
    .lt("due_date", today)
    .not("status", "in", '("draft","cancelled")')
    .limit(5000);
  if (error) throw new Error(error.message);
  const invoices = (data ?? []) as unknown as FlowInvoice[];
  let charges: LateFeeChargeRow[] = [];
  try {
    charges = (await loadChargesAndAdjustments(supabase, invoices.map((i) => i.id))).charges;
  } catch (e: any) {
    if (!isMissingTable(String(e?.message ?? ""))) throw e;
  }
  const candidate: LateFeePolicyRow = { version: 0, ...parsed.value, created_at: null };
  return { since, readOnly: true, ...comparePolicyOnHistory({ candidate, invoices, charges, today }) };
}

export async function POST(req: Request) {
  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const action = String(body?.action ?? "");
  const permission = PERMISSION_BY_ACTION[action];
  if (!permission) return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });

  const auth = await requireAdminPermission(req, permission);
  if ("error" in auth) return auth.error;
  const { supabase, user } = auth;

  try {
    switch (action) {
      case "get_estimates":
        return NextResponse.json(await getEstimates(supabase));
      case "preview_policy_comparison":
        return NextResponse.json(await previewPolicyComparison(supabase, body));
      case "preview_waiver":
        return NextResponse.json(await previewWaiver(supabase, body));
      case "post_fee":
        return NextResponse.json(await postFee(supabase, user.id, body));
      case "waive_fee":
        return NextResponse.json(await waiveFee(supabase, user.id, body));
      case "reverse_waiver":
        return NextResponse.json(await reverseWaiver(supabase, user.id, body));
      case "set_policy":
        return NextResponse.json(await setPolicy(supabase, user.id, body));
    }
    return NextResponse.json({ error: "Unhandled action" }, { status: 400 });
  } catch (error: any) {
    const message = String(error?.message ?? "Late-fee action failed");
    const status = error instanceof HttpError ? error.status : KNOWN_CONFLICTS.test(message) ? 409 : 500;
    return NextResponse.json({ error: explainLateFeeError(message) }, { status });
  }
}
