import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";
import {
  approveReferral,
  getRewardsConfig,
  getTenantPointBalance,
  listTenantLedger,
  manualAdjustPoints,
  normalizeRewardsConfig,
  redeemPoints,
  rejectReferral,
  syncPointsForTenant,
} from "@/lib/points-ledger";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body?.action ?? "");

    if (action === "save_config") {
      const auth = await requireAdminPermission(req, "rewards.manage");
      if ("error" in auth) return auth.error;
      const config = normalizeRewardsConfig(body?.config ?? {});
      const { error } = await auth.supabase
        .from("settings")
        .update({ rewards_config: config, updated_at: new Date().toISOString() })
        .eq("id", 1);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true, config });
    }

    if (action === "sync_all") {
      const auth = await requireAdminPermission(req, "rewards.manage");
      if ("error" in auth) return auth.error;
      const config = await getRewardsConfig(auth.supabase);
      const { data: tenantRows, error: tenantsError } = await auth.supabase
        .from("tenants")
        .select("id")
        .eq("status", "active");
      if (tenantsError) return NextResponse.json({ error: tenantsError.message }, { status: 500 });

      let tenantsAwarded = 0;
      let entriesAwarded = 0;
      let entriesAdjusted = 0;
      const errors: { tenantId: string; message: string }[] = [];
      for (const row of tenantRows ?? []) {
        try {
          const result = await syncPointsForTenant(auth.supabase, (row as any).id, config);
          if (result.awardedEntries.length > 0 || result.adjustedEntries.length > 0) {
            tenantsAwarded += 1;
            entriesAwarded += result.awardedEntries.length;
            entriesAdjusted += result.adjustedEntries.length;
          }
        } catch (err: any) {
          errors.push({ tenantId: (row as any).id, message: err?.message ?? "Unknown error" });
        }
      }
      return NextResponse.json({
        success: true,
        tenantsChecked: (tenantRows ?? []).length,
        tenantsAwarded,
        entriesAwarded,
        entriesAdjusted,
        errors,
      });
    }

    if (action === "tenant_summary") {
      const auth = await requireAdminPermission(req, "rewards.view");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      if (!tenantId) return NextResponse.json({ error: "Missing tenantId." }, { status: 400 });
      const config = await getRewardsConfig(auth.supabase);
      await syncPointsForTenant(auth.supabase, tenantId, config);
      const [balance, history] = await Promise.all([
        getTenantPointBalance(auth.supabase, tenantId),
        listTenantLedger(auth.supabase, tenantId),
      ]);
      return NextResponse.json({ success: true, balance, history, config });
    }

    if (action === "manual_adjust") {
      const auth = await requireAdminPermission(req, "rewards.manage");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      const points = Number(body?.points ?? 0);
      const notes = String(body?.notes ?? "");
      if (!tenantId || !Number.isFinite(points) || points === 0) {
        return NextResponse.json({ error: "Invalid adjustment." }, { status: 400 });
      }
      try {
        const entry = await manualAdjustPoints(
          auth.supabase,
          { tenantId, points, notes, createdBy: auth.user.id },
        );
        return NextResponse.json({ success: true, entry });
      } catch (err: any) {
        return NextResponse.json({ error: err?.message ?? "Failed to adjust points." }, { status: 400 });
      }
    }

    if (action === "admin_redeem") {
      const auth = await requireAdminPermission(req, "rewards.manage");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      const invoiceId = String(body?.invoiceId ?? "");
      const target = body?.target === "utility" ? "utility" : "rent";
      const pointsToRedeem = Number(body?.pointsToRedeem ?? 0);
      if (!tenantId || !invoiceId || !pointsToRedeem) {
        return NextResponse.json({ error: "Missing redemption fields." }, { status: 400 });
      }
      try {
        const result = await redeemPoints(auth.supabase, { tenantId, invoiceId, target, pointsToRedeem });
        return NextResponse.json({ success: true, ...result });
      } catch (err: any) {
        return NextResponse.json({ error: err?.message ?? "Failed to redeem points." }, { status: 400 });
      }
    }

    if (action === "list_pending_referrals") {
      const auth = await requireAdminPermission(req, "rewards.view");
      if ("error" in auth) return auth.error;
      const { data, error } = await auth.supabase
        .from("tenant_referrals")
        .select(
          "id,status,reported_at,referrer:referrer_tenant_id(id,full_name),new_tenant:new_tenant_id(id,full_name)",
        )
        .eq("status", "pending_approval")
        .order("reported_at", { ascending: true });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true, referrals: data ?? [] });
    }

    if (action === "approve_referral") {
      const auth = await requireAdminPermission(req, "rewards.manage");
      if ("error" in auth) return auth.error;
      const referralId = String(body?.referralId ?? "");
      if (!referralId) return NextResponse.json({ error: "Missing referralId." }, { status: 400 });
      try {
        const entry = await approveReferral(auth.supabase, referralId, auth.user.id);
        return NextResponse.json({ success: true, entry });
      } catch (err: any) {
        return NextResponse.json({ error: err?.message ?? "Failed to approve referral." }, { status: 400 });
      }
    }

    if (action === "reject_referral") {
      const auth = await requireAdminPermission(req, "rewards.manage");
      if ("error" in auth) return auth.error;
      const referralId = String(body?.referralId ?? "");
      if (!referralId) return NextResponse.json({ error: "Missing referralId." }, { status: 400 });
      try {
        await rejectReferral(auth.supabase, referralId, auth.user.id);
        return NextResponse.json({ success: true });
      } catch (err: any) {
        return NextResponse.json({ error: err?.message ?? "Failed to reject referral." }, { status: 400 });
      }
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const auth = await requireAdminPermission(req, "rewards.view");
    if ("error" in auth) return auth.error;

    const config = await getRewardsConfig(auth.supabase);

    const { data: tenants, error: tenantsError } = await auth.supabase
      .from("tenants")
      .select("id,full_name,status,room_id,rooms(room_number)")
      .order("full_name", { ascending: true });
    if (tenantsError) return NextResponse.json({ error: tenantsError.message }, { status: 500 });

    const tenantIds = (tenants ?? []).map((t: any) => t.id);
    const { data: allEntries, error: entriesError } = await auth.supabase
      .from("point_ledger_entries")
      .select("tenant_id,points,expires_at")
      .in("tenant_id", tenantIds.length > 0 ? tenantIds : ["00000000-0000-0000-0000-000000000000"]);
    if (entriesError) return NextResponse.json({ error: entriesError.message }, { status: 500 });

    const nowIso = new Date().toISOString();
    const balances = new Map<string, number>();
    for (const row of allEntries ?? []) {
      const r: any = row;
      if (r.expires_at && r.expires_at <= nowIso) continue;
      balances.set(r.tenant_id, (balances.get(r.tenant_id) ?? 0) + Number(r.points ?? 0));
    }

    const tenantSummaries = (tenants ?? []).map((t: any) => ({
      id: t.id,
      full_name: t.full_name,
      status: t.status,
      room_number: t.rooms?.room_number ?? null,
      balance: balances.get(t.id) ?? 0,
    }));

    tenantSummaries.sort((a, b) => {
      if (!a.room_number) return 1;
      if (!b.room_number) return -1;
      return a.room_number.localeCompare(b.room_number, undefined, { numeric: true, sensitivity: "base" });
    });

    return NextResponse.json({ success: true, config, tenants: tenantSummaries });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
  }
}
