import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { Client, FlexMessage } from "@line/bot-sdk";
import { requireLineAdminAccess } from "@/lib/line-admin-auth";
import { applyInvoicePaymentAllocation } from "@/lib/invoice-ledger";

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
      const { error } = await supabase.from("invoices").update({ status }).eq("id", invoiceId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    if (action === "approve_paid") {
      const paymentDateInput = String(body?.paymentDate ?? "").trim();
      const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(paymentDateInput)
        ? paymentDateInput
        : null;
      const { data: current, error: fetchError } = await supabase
        .from("invoices")
        .select("total_amount,paid_amount,payment_history,slip_url")
        .eq("id", invoiceId)
        .single();
      if (fetchError || !current) {
        return NextResponse.json({ error: fetchError?.message ?? "Invoice not found" }, { status: 404 });
      }
      const nowIso = selectedDate
        ? new Date(`${selectedDate}T12:00:00`).toISOString()
        : new Date().toISOString();
      const result = await applyInvoicePaymentAllocation(supabase, {
        invoiceId,
        amount: Number.MAX_SAFE_INTEGER,
        paidAt: nowIso,
        slipUrl: ((current as any).slip_url as string | null | undefined) ?? null,
        mode: "full",
        source: "admin_liff_approve",
      });
      return NextResponse.json({ success: true, ...result });
    }

    if (action === "edit_invoice") {
      const payload = body?.payload ?? {};
      const updatePayload: Record<string, unknown> = {};
      if (payload?.due_date) updatePayload.due_date = String(payload.due_date);
      if (payload?.issue_date) updatePayload.issue_date = String(payload.issue_date);
      if (payload?.total_amount != null) {
        const amount = Number(payload.total_amount);
        if (Number.isNaN(amount) || amount < 0) {
          return NextResponse.json({ error: "Invalid total amount" }, { status: 400 });
        }
        updatePayload.total_amount = amount;
      }
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
      const baseUrlRaw = (process.env.NEXT_PUBLIC_BASE_URL || "").trim();
      if (!baseUrlRaw) {
        return NextResponse.json({ error: "NEXT_PUBLIC_BASE_URL is missing" }, { status: 500 });
      }
      const baseUrl = /^https?:\/\//i.test(baseUrlRaw) ? baseUrlRaw : `https://${baseUrlRaw}`;
      const payUrl = `${baseUrl.replace(/\/$/, "")}/payment/${token}`;

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
