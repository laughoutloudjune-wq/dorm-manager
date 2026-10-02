import { NextResponse } from "next/server";
import { Client } from "@line/bot-sdk";
import { createAdminClient } from "@/lib/supabase-admin";
import { runReconciliationChecks, type ReconciliationFinding } from "@/lib/reconciliation";
import { findMeterAnomalies, type MeterAnomaly } from "@/lib/meter-anomalies";
import { OPEN_INVOICE_STATUSES, sumOwnOutstanding } from "@/lib/invoice-ledger";
import { addDaysToDate, bangkokDayStartIso, toBangkokDate, toBangkokMonth } from "@/lib/money/bangkok-date";
import { BASIS_LABELS, REPORT_TERMS, fetchReceiptLedger, summarizeAllocations } from "@/lib/money/report-definitions";

const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const recipientIds = (process.env.LINE_DIGEST_ADMIN_USER_IDS || process.env.LINE_ADMIN_USER_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

/**
 * Fails CLOSED: with no CRON_SECRET configured, this route refuses every
 * request rather than running unauthenticated (this is a public endpoint —
 * anything else would be its own new instance of finding C1).
 */
const isAuthorized = (req: Request) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
};


const formatMoney = (value: number) =>
  Number(value || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Digest = {
  generatedAt: string;
  receivedYesterday: number;
  creditAppliedYesterday: number;
  overdueCount: number;
  overdueAmount: number;
  slipsWaiting: number;
  reconciliationFindings: ReconciliationFinding[];
  meterAnomalies: MeterAnomaly[];
};

function buildDigestFlexMessage(digest: Digest) {
  const flags: Array<ReconciliationFinding | MeterAnomaly> = [
    ...digest.reconciliationFindings,
    ...digest.meterAnomalies,
  ];
  const ordered = [...flags].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1));
  const flagLines = ordered.slice(0, 10).map((flag) => ({
    type: "text" as const,
    text: `${flag.severity === "high" ? "\u{1F534}" : "\u{1F7E1}"} ${flag.text}`,
    size: "xs" as const,
    wrap: true,
    color: "#374151",
    margin: "sm" as const,
  }));
  const overflowCount = ordered.length - flagLines.length;

  return {
    type: "flex" as const,
    altText: `สรุปประจำวัน: ${REPORT_TERMS.cashReceived.th}เมื่อวาน ฿${formatMoney(digest.receivedYesterday)} ค้างชำระ ${digest.overdueCount} บิล พบ ${ordered.length} รายการต้องตรวจสอบ`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#0F172A",
        paddingAll: "20px",
        contents: [{ type: "text", text: "สรุปประจำวัน", weight: "bold", size: "xl", color: "#FFFFFF" }],
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: `${REPORT_TERMS.cashReceived.th}เมื่อวาน: ฿${formatMoney(digest.receivedYesterday)}`,
            size: "sm",
            color: "#111827",
          },
          ...(digest.creditAppliedYesterday !== 0
            ? [
                {
                  type: "text" as const,
                  text: `${REPORT_TERMS.creditApplied.th}เมื่อวาน: ฿${formatMoney(digest.creditAppliedYesterday)}`,
                  size: "sm" as const,
                  color: "#111827",
                },
              ]
            : []),
          { type: "text", text: `(${BASIS_LABELS.cash.th})`, size: "xxs", color: "#6B7280" },
          {
            type: "text",
            text: `บิลค้างชำระ: ${digest.overdueCount} รายการ (฿${formatMoney(digest.overdueAmount)})`,
            size: "sm",
            color: "#111827",
          },
          { type: "text", text: `สลิปรอตรวจสอบ: ${digest.slipsWaiting} รายการ`, size: "sm", color: "#111827" },
          ...(flagLines.length > 0
            ? [
                { type: "separator" as const, margin: "md" as const },
                {
                  type: "text" as const,
                  text: `รายการที่ควรตรวจสอบ (${ordered.length})`,
                  weight: "bold" as const,
                  size: "sm" as const,
                  margin: "md" as const,
                },
                ...flagLines,
                ...(overflowCount > 0
                  ? [
                      {
                        type: "text" as const,
                        text: `และอีก ${overflowCount} รายการ — ดูทั้งหมดในระบบ`,
                        size: "xs" as const,
                        color: "#6B7280",
                        margin: "sm" as const,
                      },
                    ]
                  : []),
              ]
            : []),
        ],
      },
    },
  };
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const dryRun = ["1", "true"].includes(url.searchParams.get("dryRun") ?? "");

  try {
    const supabase = createAdminClient();
    const now = new Date();

    // "Yesterday" via UTC calendar boundaries — the same toISOString-based
    // convention used everywhere else in this codebase today. CLAUDE.md
    // (finding M10) already documents this as not Bangkok-local and not yet
    // fixed anywhere; matching it here rather than introducing a one-off
    // "more correct" boundary that would disagree with every other date
    // computation in the app.
    const todayBangkok = toBangkokDate(now);
    const yesterdayStartIso = bangkokDayStartIso(addDaysToDate(todayBangkok, -1));
    const todayStartIso = bangkokDayStartIso(todayBangkok);

    const [paidYesterdayRes, openInvoicesRes, slipsWaitingRes, reconciliationFindings, meterAnomalies] =
      await Promise.all([
        fetchReceiptLedger(supabase, yesterdayStartIso, todayStartIso),
        supabase
          .from("invoices")
          .select("id,status,total_amount,paid_amount,carry_forward_amount")
          .in("status", [...OPEN_INVOICE_STATUSES]),
        supabase.from("invoices").select("id", { count: "exact", head: true }).eq("status", "verifying"),
        runReconciliationChecks(supabase),
        findMeterAnomalies(supabase, toBangkokMonth(now)),
      ]);

    if (paidYesterdayRes.error) throw new Error(paidYesterdayRes.error);
    // Cash basis (by actual receipt date): non-voided receipts net of
    // reversals; abandon_room/credit settlements are credit, not cash.
    const yesterdayReceipts = summarizeAllocations(paidYesterdayRes.rows, paidYesterdayRes.voidedBatchIds);
    const receivedYesterday = yesterdayReceipts.cashReceived;
    const creditAppliedYesterday = yesterdayReceipts.creditApplied;
    const overdueRows = (openInvoicesRes.data ?? []).filter((row: any) => row.status === "overdue");

    const digest: Digest = {
      generatedAt: now.toISOString(),
      receivedYesterday,
      creditAppliedYesterday,
      overdueCount: overdueRows.length,
      overdueAmount: sumOwnOutstanding(overdueRows as any),
      slipsWaiting: slipsWaitingRes.count ?? 0,
      reconciliationFindings,
      meterAnomalies,
    };

    if (dryRun) {
      return NextResponse.json({ dryRun: true, digest });
    }

    if (!channelAccessToken || recipientIds.length === 0) {
      return NextResponse.json(
        {
          error:
            "LINE_CHANNEL_ACCESS_TOKEN or LINE_DIGEST_ADMIN_USER_IDS/LINE_ADMIN_USER_IDS not configured.",
          digest,
        },
        { status: 500 }
      );
    }

    const lineClient = new Client({ channelAccessToken });
    const message = buildDigestFlexMessage(digest);
    await Promise.all(recipientIds.map((userId) => lineClient.pushMessage(userId, message as any)));

    return NextResponse.json({ success: true, digest });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unexpected error" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
