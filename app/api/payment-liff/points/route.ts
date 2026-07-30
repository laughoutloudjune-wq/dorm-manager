import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import {
  getRewardsConfig,
  getTenantPointBalance,
  listTenantLedger,
  redeemPoints,
  syncPointsForTenant,
} from "@/lib/points-ledger";

const verifyLineProfile = async (accessToken: string) => {
  const profileResponse = await fetch("https://api.line.me/v2/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!profileResponse.ok) throw new Error("LINE profile verification failed");
  return (await profileResponse.json()) as { userId?: string };
};

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body?.action ?? "get_summary");
    const accessToken = String(body?.accessToken ?? "");

    if (!accessToken) {
      return NextResponse.json({ error: "Missing access token" }, { status: 400 });
    }

    const profile = await verifyLineProfile(accessToken);
    const lineUserId = String(profile.userId ?? "");
    if (!lineUserId) {
      return NextResponse.json({ error: "LINE user not found" }, { status: 401 });
    }

    const supabase = createAdminClient();
    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id,full_name,room_id,rooms(room_number)")
      .eq("line_user_id", lineUserId)
      .maybeSingle();
    if (tenantError) return NextResponse.json({ error: tenantError.message }, { status: 500 });
    if (!tenant) {
      return NextResponse.json({ tenant: null, message: "ไม่พบบัญชีผู้เช่าที่เชื่อมกับ LINE นี้" });
    }

    const config = await getRewardsConfig(supabase);

    if (action === "redeem") {
      const invoiceId = String(body?.invoiceId ?? "");
      const target = body?.target === "utility" ? "utility" : "rent";
      const pointsToRedeem = Number(body?.pointsToRedeem ?? 0);
      if (!invoiceId || !pointsToRedeem) {
        return NextResponse.json({ error: "Missing redemption fields." }, { status: 400 });
      }
      try {
        const result = await redeemPoints(
          supabase,
          { tenantId: tenant.id, invoiceId, target, pointsToRedeem },
          config,
        );
        const balance = await getTenantPointBalance(supabase, tenant.id);
        const history = await listTenantLedger(supabase, tenant.id);
        return NextResponse.json({ success: true, ...result, balance, history });
      } catch (err: any) {
        return NextResponse.json({ error: err?.message ?? "แลกคะแนนไม่สำเร็จ" }, { status: 400 });
      }
    }

    // get_summary (default): recompute any newly-earned points, then return
    // balance/history plus whether an open invoice exists to redeem against.
    await syncPointsForTenant(supabase, tenant.id, config);
    const [balance, history, { data: openInvoice }] = await Promise.all([
      getTenantPointBalance(supabase, tenant.id),
      listTenantLedger(supabase, tenant.id),
      supabase
        .from("invoices")
        .select("id,issue_date,due_date,total_amount,paid_amount,status")
        .eq("tenant_id", tenant.id)
        .in("status", ["pending", "overdue", "partial"])
        .order("due_date", { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);

    const roomRel = Array.isArray((tenant as any).rooms) ? (tenant as any).rooms[0] : (tenant as any).rooms;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const redemptionsThisMonth = history.filter(
      (row) => row.reason === "redemption" && row.created_at >= monthStart,
    ).length;

    return NextResponse.json({
      tenant: {
        id: tenant.id,
        full_name: (tenant as any).full_name,
        room_number: roomRel?.room_number ?? "-",
      },
      balance,
      history,
      config,
      openInvoice: openInvoice ?? null,
      canRedeem: !!openInvoice && redemptionsThisMonth < config.max_redemptions_per_month,
      message: null,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unexpected server error" }, { status: 500 });
  }
}
