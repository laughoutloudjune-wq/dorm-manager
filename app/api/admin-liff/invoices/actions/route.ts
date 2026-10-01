import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { Client, FlexMessage } from "@line/bot-sdk";
import { requireLineAdminAccess } from "@/lib/line-admin-auth";
import {
  applyInvoicePaymentAllocation,
  getPaymentChainOutstanding,
  calculateLateFeeAmount,
  resolveFullyPaidAtDate,
  resolvePaymentMethodForTenant,
} from "@/lib/invoice-ledger";
import { loadV2LateFeeStates, refreshV2InvoiceStatuses } from "@/lib/fee-model-v2";
import { bangkokYmd } from "@/lib/move-out-notice";
import { roundTo2 } from "@/lib/format";
import { syncPointsForTenant } from "@/lib/points-ledger";
import { notifyTenantPointsEarned } from "@/lib/points-notify";
import { declinePaymentSlip } from "@/lib/slip-review";
import { notifyTenantSlipDeclined } from "@/lib/slip-notify";
import { getPublicSiteOrigin } from "@/lib/public-site-url";
import type { SupabaseClient } from "@supabase/supabase-js";

async function syncPointsAfterPayment(supabase: SupabaseClient, invoiceId: string) {
  try {
    const { data } = await supabase.from("invoices").select("tenant_id").eq("id", invoiceId).maybeSingle();
    const tenantId = (data as any)?.tenant_id;
    if (tenantId) {
      const result = await syncPointsForTenant(supabase, tenantId);
      await notifyTenantPointsEarned(supabase, tenantId, result.awardedEntries);
    }
  } catch (err) {
    console.error("[rewards] Failed to sync points after payment for invoice:", invoiceId, err);
  }
}

const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const lineClient = new Client({ channelAccessToken });

const formatMoney = (value: number) =>
  Number(value || 0).toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const accessToken = String(body?.accessToken ?? "");
    const action = String(body?.action ?? "");
    const invoiceId = String(body?.invoiceId ?? "");
    if (!accessToken || !action || !invoiceId) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const auth = await requireLineAdminAccess(accessToken);
    if ("error" in auth) return auth.error;

    const supabase = createAdminClient();

    if (action === "update_status") {
      const status = String(body?.status ?? "");
      const allowed = ["draft", "pending", "partial", "verifying", "paid", "overdue", "cancelled"];
      if (!allowed.includes(status)) {
        return NextResponse.json({ error: "Invalid status" }, { status: 400 });
      }
      const { data: beforeRow } = await supabase
        .from("invoices")
        .select("status,fee_model")
        .eq("id", invoiceId)
        .maybeSingle();
      const wasPaid = String((beforeRow as any)?.status ?? "") === "paid";
      // Same rule as the web admin route: on a v2 bill "paid" is calculated
      // from real money, never picked by hand (design B4).
      if ((beforeRow as any)?.fee_model === "v2" && status === "paid") {
        return NextResponse.json(
          {
            error:
              "บิลนี้ใช้กติกาค่าปรับใหม่ สถานะ “ชำระแล้ว” จะเปลี่ยนเองเมื่อรับเงินครบ ตั้งเองไม่ได้ (ใช้ปุ่มอนุมัติสลิป)",
          },
          { status: 400 },
        );
      }

      const { error } = await supabase.from("invoices").update({ status }).eq("id", invoiceId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      // Same fix as the web admin route: points must be revoked when status
      // LEAVES paid, not just awarded when it becomes paid.
      if (status === "paid" || wasPaid) {
        await syncPointsAfterPayment(supabase, invoiceId);
      }

      return NextResponse.json({ success: true });
    }

    if (action === "approve_paid") {
      const paymentDateInput = String(body?.paymentDate ?? "").trim();
      const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(paymentDateInput)
        ? paymentDateInput
        : null;
      const { data: current, error: fetchError } = await supabase
        .from("invoices")
        .select("status,total_amount,paid_amount,payment_history,slip_url,fee_model,tenant_id")
        .eq("id", invoiceId)
        .single();
      if (fetchError || !current) {
        return NextResponse.json({ error: fetchError?.message ?? "Invoice not found" }, { status: 404 });
      }
      const nowIso = selectedDate
        ? new Date(`${selectedDate}T12:00:00`).toISOString()
        : new Date().toISOString();

      if ((current as any).fee_model === "v2") {
        // v2 (design B3): the slip becomes money only through the
        // record_payment database function — one split line on THIS bill,
        // capped at the engine's amount due (charges + late fee − waived −
        // paid) as of the transfer date. Never the legacy chain allocator,
        // which knows nothing about a v2 bill's fee.
        if (String((current as any).status ?? "") !== "verifying" || !(current as any).slip_url) {
          return NextResponse.json(
            {
              error:
                "ไม่สามารถอนุมัติได้ เนื่องจากใบแจ้งหนี้นี้ไม่มีสลิปที่รอตรวจสอบ กรุณาให้ผู้เช่าอัปโหลดสลิปก่อน",
            },
            { status: 400 },
          );
        }
        const tenantId = String((current as any).tenant_id ?? "");
        const asOf = bangkokYmd(new Date(nowIso));
        const atTransfer = (await loadV2LateFeeStates(supabase, [invoiceId], asOf)).get(invoiceId);
        const today = (await loadV2LateFeeStates(supabase, [invoiceId])).get(invoiceId);
        if (!atTransfer || !today) {
          return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
        }
        // A backdated approval must not pay for charges a later-dated payment
        // already covered: never more than what is owed on either date.
        const due = roundTo2(Math.min(atTransfer.balance.amountDue, today.balance.amountDue));
        const requested = Number(body?.amount);
        const amount =
          Number.isFinite(requested) && requested > 0 ? roundTo2(Math.min(requested, due)) : due;
        if (amount <= 0) {
          await refreshV2InvoiceStatuses(supabase, { invoiceIds: [invoiceId] });
          await syncPointsAfterPayment(supabase, invoiceId);
          return NextResponse.json({ success: true, alreadySettled: true });
        }
        const slipUrl = String((current as any).slip_url);
        const { data: rpc, error: rpcError } = await supabase.rpc("record_payment", {
          p_tenant_id: tenantId,
          p_amount_received: amount,
          p_paid_at: nowIso,
          p_slip_url: slipUrl,
          p_source: "admin_liff_approve",
          p_split: [
            {
              invoice_id: invoiceId,
              amount,
              expected_amount_due: due,
              expected_paid_sum: atTransfer.paidSum,
              expected_waived_sum: atTransfer.waivedSum,
            },
          ],
          p_payment_method_snapshot: (await resolvePaymentMethodForTenant(supabase, tenantId)).snapshot,
          // Stable per slip: a double tap replays instead of paying twice.
          p_idempotency_key: `liff_approve:${invoiceId}:${slipUrl}`,
          p_created_by: `line:${auth.profile.userId}`,
        });
        if (rpcError) {
          return NextResponse.json({ error: rpcError.message }, { status: 400 });
        }
        await syncPointsAfterPayment(supabase, invoiceId);
        return NextResponse.json({ success: true, result: (rpc as any)?.result ?? null, appliedAmount: amount });
      }

      // Already settled (e.g. approving an invoice whose status was flipped away
      // from paid and back): the money is still recorded, nothing left to
      // allocate. Restore the status instead of throwing "already fully paid".
      const chainOutstanding = await getPaymentChainOutstanding(supabase, invoiceId);
      if (chainOutstanding <= 0) {
        const statusPayload: Record<string, unknown> = { status: "paid" };

        // Re-freeze the late fee if it is unfrozen — see the equivalent branch
        // in app/api/admin/invoices/actions/route.ts.
        const { data: feeRow } = await supabase
          .from("invoices")
          .select(
            "locked_late_fee_amount,late_fee_start_date,late_fee_per_day,waived_late_fee_amount,payment_history,slip_uploaded_at",
          )
          .eq("id", invoiceId)
          .maybeSingle();
        if (feeRow && (feeRow as any).locked_late_fee_amount == null) {
          statusPayload.locked_late_fee_amount = calculateLateFeeAmount(
            feeRow as any,
            resolveFullyPaidAtDate(feeRow as any, new Date().toISOString().slice(0, 10)),
          );
        }

        const { error: statusError } = await supabase
          .from("invoices")
          .update(statusPayload)
          .eq("id", invoiceId);
        if (statusError) {
          return NextResponse.json({ error: statusError.message }, { status: 500 });
        }
        await syncPointsAfterPayment(supabase, invoiceId);
        return NextResponse.json({ success: true, alreadySettled: true });
      }

      // SAFEGUARD: "approve" may only turn a REVIEWED slip into a recorded
      // payment. It must never fabricate a payment for whatever is still
      // outstanding — that is exactly how this system accumulated fake
      // batches: an admin tapped "approve" on an invoice with no slip, or one
      // still mid-conversation, and the remaining balance got treated as cash
      // received. `status === "verifying"` is set only when a tenant has
      // actually uploaded a slip pending review, so it plus a non-empty
      // `slip_url` is the one legitimate trigger for creating money here.
      if (
        String((current as any).status ?? "") !== "verifying" ||
        !(current as any).slip_url
      ) {
        return NextResponse.json(
          {
            error:
              "ไม่สามารถอนุมัติได้ เนื่องจากใบแจ้งหนี้นี้ไม่มีสลิปที่รอตรวจสอบ กรุณาให้ผู้เช่าอัปโหลดสลิปก่อน",
          },
          { status: 400 },
        );
      }

      const result = await applyInvoicePaymentAllocation(supabase, {
        invoiceId,
        amount: Number.MAX_SAFE_INTEGER,
        paidAt: nowIso,
        slipUrl: ((current as any).slip_url as string | null | undefined) ?? null,
        mode: "full",
        source: "admin_liff_approve",
        createdBy: `line:${auth.profile.userId}`,
      });
      await syncPointsAfterPayment(supabase, invoiceId);
      return NextResponse.json({ success: true, ...result });
    }

    if (action === "decline_slip") {
      const reason = String(body?.reason ?? "");
      try {
        // The LIFF admin has no Supabase user row — identify the reviewer by the
        // LINE user id that requireLineAdminAccess already vetted.
        const result = await declinePaymentSlip(supabase, {
          invoiceId,
          reason,
          reviewedBy: `line:${auth.profile.userId}`,
        });
        await notifyTenantSlipDeclined(supabase, {
          tenantId: result.tenantId,
          invoiceId,
          reason: result.reason,
        });
        return NextResponse.json({ success: true, ...result });
      } catch (err: any) {
        return NextResponse.json(
          { error: err?.message ?? "Failed to decline the payment slip." },
          { status: 400 },
        );
      }
    }

    if (action === "edit_invoice") {
      const payload = body?.payload ?? {};
      const updatePayload: Record<string, unknown> = {};
      if (payload?.due_date) updatePayload.due_date = String(payload.due_date);
      if (payload?.issue_date) updatePayload.issue_date = String(payload.issue_date);
      // A raw client-supplied total_amount used to be accepted here with no
      // reconciliation against the invoice's own component columns
      // (rent/water/electricity/late fee/carry-forward), via computeInvoiceTotal
      // — the only route in the app allowed to set a total this way. Nothing
      // in the LINE admin UI currently calls this with total_amount (it's
      // unreachable dead capability, not a used feature), so it's removed
      // rather than reconciled: a total edit belongs on the invoice's
      // component fields, run through the one engine, same as everywhere else.
      if (payload?.status) {
        const nextStatus = String(payload.status);
        const allowed = ["draft", "pending", "partial", "verifying", "paid", "overdue", "cancelled"];
        if (!allowed.includes(nextStatus)) {
          return NextResponse.json({ error: "Invalid status" }, { status: 400 });
        }
        updatePayload.status = nextStatus;
      }
      if (Object.keys(updatePayload).length === 0) {
        return NextResponse.json({ error: "No fields to update" }, { status: 400 });
      }
      const { error } = await supabase.from("invoices").update(updatePayload).eq("id", invoiceId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    if (action === "resend_invoice") {
      if (!channelAccessToken) {
        return NextResponse.json({ error: "LINE channel access token is missing." }, { status: 500 });
      }
      const { data: invoice, error: invoiceError } = await supabase
        .from("invoices")
        .select(
          "id,public_token,total_amount,due_date,rent_amount,water_bill,electricity_bill,common_fee,additional_fees_total,tenants(line_user_id),rooms(room_number)"
        )
        .eq("id", invoiceId)
        .single();
      if (invoiceError || !invoice) {
        return NextResponse.json(
          { error: invoiceError?.message ?? "Invoice not found" },
          { status: 404 }
        );
      }
      const tenant = Array.isArray((invoice as any).tenants)
        ? (invoice as any).tenants[0]
        : (invoice as any).tenants;
      const room = Array.isArray((invoice as any).rooms)
        ? (invoice as any).rooms[0]
        : (invoice as any).rooms;
      const lineUserId = String(tenant?.line_user_id ?? "");
      if (!lineUserId) {
        return NextResponse.json({ error: "Tenant has no LINE user ID" }, { status: 400 });
      }
      const token = String((invoice as any).public_token ?? "");
      if (!token) {
        return NextResponse.json({ error: "Invoice has no public token" }, { status: 400 });
      }
      const origin = getPublicSiteOrigin();
      if (!origin) {
        return NextResponse.json(
          {
            error:
              "No public URL for payment links. Set INVOICE_PUBLIC_BASE_URL to your Vercel origin when using localhost, or set NEXT_PUBLIC_BASE_URL / deploy on Vercel (VERCEL_URL).",
          },
          { status: 500 }
        );
      }
      const payUrl = `${origin}/payment/${token}`;

      const flexMessage: FlexMessage = {
        type: "flex",
        altText: `ใบแจ้งหนี้ห้อง ${room?.room_number ?? "-"}`,
        contents: {
          type: "bubble",
          body: {
            type: "box",
            layout: "vertical",
            contents: [
              { type: "text", text: "แจ้งเตือนใบแจ้งหนี้", weight: "bold", size: "xl" },
              { type: "text", text: `ห้อง ${room?.room_number ?? "-"}`, margin: "md", size: "sm" },
              {
                type: "text",
                text: `ยอดรวม ${formatMoney(Number((invoice as any).total_amount ?? 0))} บาท`,
                margin: "sm",
                size: "sm",
              },
              {
                type: "text",
                text: `ครบกำหนด ${
                  (invoice as any).due_date
                    ? new Date((invoice as any).due_date).toLocaleDateString("th-TH")
                    : "-"
                }`,
                margin: "sm",
                size: "sm",
              },
            ],
          },
          footer: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
              {
                type: "button",
                style: "primary",
                action: {
                  type: "uri",
                  label: "เปิดใบแจ้งหนี้",
                  uri: payUrl,
                },
              },
            ],
          },
        },
      };
      await lineClient.pushMessage(lineUserId, flexMessage);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}
