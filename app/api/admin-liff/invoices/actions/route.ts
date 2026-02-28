import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";

const adminLineUserIds = (process.env.LINE_ADMIN_USER_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

async function verifyLineAccessToken(accessToken: string) {
  const profileResponse = await fetch("https://api.line.me/v2/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!profileResponse.ok) return null;
  return (await profileResponse.json()) as {
    userId: string;
    displayName: string;
  };
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const accessToken = String(body?.accessToken ?? "");
    const action = String(body?.action ?? "");
    const invoiceId = String(body?.invoiceId ?? "");
    if (!accessToken || !action || !invoiceId) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const profile = await verifyLineAccessToken(accessToken);
    if (!profile) {
      return NextResponse.json({ error: "LINE profile verification failed" }, { status: 401 });
    }
    if (!adminLineUserIds.includes(profile.userId)) {
      return NextResponse.json({ error: "LINE account is not allowed for admin LIFF" }, { status: 403 });
    }

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
      const { data: current, error: fetchError } = await supabase
        .from("invoices")
        .select("total_amount,paid_amount,payment_history,slip_url")
        .eq("id", invoiceId)
        .single();
      if (fetchError || !current) {
        return NextResponse.json({ error: fetchError?.message ?? "Invoice not found" }, { status: 404 });
      }
      const total = Number((current as any).total_amount ?? 0);
      const currentPaid = Number((current as any).paid_amount ?? 0);
      const addAmount = Math.max(0, total - currentPaid);
      const nowIso = new Date().toISOString();
      const existingHistory = Array.isArray((current as any).payment_history)
        ? ((current as any).payment_history as any[])
        : [];
      const nextHistory =
        addAmount > 0
          ? [
              ...existingHistory,
              {
                amount: addAmount,
                mode: "full",
                paid_at: nowIso,
                slip_url: (current as any).slip_url ?? null,
                created_at: nowIso,
                source: "admin_liff_approve",
              },
            ]
          : existingHistory;
      const { error } = await supabase
        .from("invoices")
        .update({
          status: "paid",
          paid_amount: total,
          payment_history: nextHistory,
          slip_uploaded_at: nowIso,
        })
        .eq("id", invoiceId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
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
