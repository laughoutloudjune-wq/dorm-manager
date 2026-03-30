import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";

const toNumber = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const roundTo2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

const calculateTransferRentProration = (
  transferDate: string,
  moveInDate: string | null | undefined,
  oldRoomRate: number,
  newRoomRate: number
) => {
  const transferDateObj = new Date(transferDate);
  const transferYear = transferDateObj.getFullYear();
  const transferMonth = transferDateObj.getMonth();
  const periodStart = new Date(transferYear, transferMonth, 1);
  const periodEnd = new Date(transferYear, transferMonth + 1, 0);
  const daysInMonth = periodEnd.getDate();
  const billingStart = moveInDate ? new Date(moveInDate) : periodStart;
  const effectiveBillingStart = billingStart > periodStart ? billingStart : periodStart;
  const effectiveTransferDate = transferDateObj > effectiveBillingStart ? transferDateObj : effectiveBillingStart;
  const oldSegmentEnd = new Date(
    effectiveTransferDate.getFullYear(),
    effectiveTransferDate.getMonth(),
    effectiveTransferDate.getDate() - 1
  );
  const oldRoomDays =
    effectiveTransferDate > effectiveBillingStart
      ? Math.floor((oldSegmentEnd.getTime() - effectiveBillingStart.getTime()) / 86400000) + 1
      : 0;
  const newRoomDays =
    periodEnd >= effectiveTransferDate
      ? Math.floor((periodEnd.getTime() - effectiveTransferDate.getTime()) / 86400000) + 1
      : 0;
  const dailyOldRate = oldRoomRate / 30;
  const dailyNewRate = newRoomRate / 30;

  return {
    oldRoomAmount: roundTo2(dailyOldRate * oldRoomDays),
    newRoomAmount: roundTo2(dailyNewRate * newRoomDays),
  };
};

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body?.action ?? "");

    if (action === "save_tenant") {
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;
      const payload = { ...(body?.payload ?? {}) } as any;
      const transferPayload = (body?.transferPayload ?? null) as any;
      const roomId = body?.roomId ? String(body.roomId) : "";
      if (!payload.id) payload.id = crypto.randomUUID();
      const tenantId = String(payload.id);

      let previousTenant: any = null;
      if (tenantId) {
        const { data } = await auth.supabase
          .from("tenants")
          .select("id,room_id,move_in_date,full_name")
          .eq("id", tenantId)
          .maybeSingle();
        previousTenant = data ?? null;
      }

      if (roomId) {
        const { data: existingTenant, error: existingTenantError } = await auth.supabase
          .from("tenants")
          .select("id,full_name")
          .eq("room_id", roomId)
          .eq("status", "active")
          .neq("id", tenantId)
          .limit(1)
          .maybeSingle();

        if (existingTenantError) {
          return NextResponse.json({ error: existingTenantError.message }, { status: 500 });
        }

        if (existingTenant?.id) {
          return NextResponse.json(
            {
              error: `ห้องนี้มีผู้เช่าอยู่แล้ว (${existingTenant.full_name ?? "ไม่ทราบชื่อ"}) กรุณาย้ายออกหรือเปลี่ยนห้องก่อนเพิ่มผู้เช่าใหม่`,
            },
            { status: 400 }
          );
        }
      }

      const { error } = await auth.supabase.from("tenants").upsert(payload, { onConflict: "id" });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      const effectiveTenantId = tenantId;
      const moveInDate = payload?.move_in_date ? String(payload.move_in_date) : null;
      const fullName = payload?.full_name ? String(payload.full_name) : null;

      const shouldLogMoveIn =
        !!roomId &&
        !!moveInDate &&
        !!fullName &&
        (!previousTenant ||
          String(previousTenant.room_id ?? "") !== roomId ||
          String(previousTenant.move_in_date ?? "") !== moveInDate);

      const roomChanged =
        !!previousTenant &&
        !!previousTenant.room_id &&
        String(previousTenant.room_id) !== roomId;

      if (roomChanged) {
        const closeDate = moveInDate || new Date().toISOString().slice(0, 10);
        await auth.supabase
          .from("room_tenant_logs")
          .update({ move_out_date: closeDate, updated_at: new Date().toISOString() })
          .eq("room_id", String(previousTenant.room_id))
          .eq("tenant_id", tenantId)
          .is("move_out_date", null);

        if (transferPayload?.transfer_date) {
          const roomIds = [String(previousTenant.room_id), roomId];
          const { data: roomRates, error: roomRatesError } = await auth.supabase
            .from("rooms")
            .select("id,price_month")
            .in("id", roomIds);

          if (roomRatesError) {
            return NextResponse.json({ error: roomRatesError.message }, { status: 500 });
          }

          const oldRoomRate =
            roomRates?.find((room) => String(room.id) === String(previousTenant.room_id))?.price_month ?? 0;
          const newRoomRate =
            roomRates?.find((room) => String(room.id) === roomId)?.price_month ?? 0;
          const transferRent = calculateTransferRentProration(
            String(transferPayload.transfer_date),
            previousTenant?.move_in_date ? String(previousTenant.move_in_date) : null,
            toNumber(oldRoomRate),
            toNumber(newRoomRate)
          );

          const transferInsert = {
            id: crypto.randomUUID(),
            tenant_id: tenantId,
            from_room_id: String(previousTenant.room_id),
            to_room_id: roomId,
            transfer_date: String(transferPayload.transfer_date),
            billing_month: String(
              transferPayload.billing_month ??
                `${String(transferPayload.transfer_date).slice(0, 7)}-01`
            ),
            old_prev_electricity: Number(transferPayload.old_prev_electricity ?? 0),
            old_curr_electricity: Number(transferPayload.old_curr_electricity ?? 0),
            old_prev_water: Number(transferPayload.old_prev_water ?? 0),
            old_curr_water: Number(transferPayload.old_curr_water ?? 0),
            new_prev_electricity: Number(transferPayload.new_prev_electricity ?? 0),
            new_curr_electricity: Number(transferPayload.new_curr_electricity ?? 0),
            new_prev_water: Number(transferPayload.new_prev_water ?? 0),
            new_curr_water: Number(transferPayload.new_curr_water ?? 0),
            old_electric_usage: Number(transferPayload.old_electric_usage ?? 0),
            old_water_usage: Number(transferPayload.old_water_usage ?? 0),
            old_rent_amount: transferRent.oldRoomAmount,
            new_rent_amount: transferRent.newRoomAmount,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          await auth.supabase.from("tenant_room_transfers").insert(transferInsert);
        }
      }

      if (shouldLogMoveIn) {
        await auth.supabase.from("room_tenant_logs").upsert(
          {
            room_id: roomId,
            tenant_id: effectiveTenantId || null,
            tenant_name: fullName,
            move_in_date: moveInDate,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "room_id,tenant_id,move_in_date" }
        );
      }

      if (roomId) {
        const roomAuth = await requireAdminPermission(req, "room.edit");
        if ("error" in roomAuth) return roomAuth.error;
        await roomAuth.supabase.from("rooms").update({ status: "occupied" }).eq("id", roomId);
        await roomAuth.supabase.from("room_logs").insert({
          room_id: roomId,
          event_type: "move_in",
          created_at: new Date().toISOString(),
        });
      }
      return NextResponse.json({ success: true });
    }

    if (action === "delete_tenant") {
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      const { error } = await auth.supabase.from("tenants").delete().eq("id", tenantId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    if (action === "unlink_line") {
      const auth = await requireAdminPermission(req, "tenant.line.manage");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      const { error } = await auth.supabase.from("tenants").update({ line_user_id: null }).eq("id", tenantId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    if (action === "move_out") {
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;
      const roomAuth = await requireAdminPermission(req, "room.edit");
      if ("error" in roomAuth) return roomAuth.error;

      const tenantId = String(body?.tenantId ?? "");
      const roomId = String(body?.roomId ?? "");
      const payload = body?.payload ?? {};
      const { error } = await auth.supabase.from("tenants").update(payload).eq("id", tenantId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      const moveOutDate = payload?.move_out_date ? String(payload.move_out_date) : new Date().toISOString().slice(0, 10);
      const { data: openLog } = await auth.supabase
        .from("room_tenant_logs")
        .select("id")
        .eq("room_id", roomId)
        .eq("tenant_id", tenantId)
        .is("move_out_date", null)
        .order("move_in_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (openLog?.id) {
        await auth.supabase
          .from("room_tenant_logs")
          .update({ move_out_date: moveOutDate, updated_at: new Date().toISOString() })
          .eq("id", openLog.id);
      }

      await roomAuth.supabase.from("rooms").update({ status: "available" }).eq("id", roomId);
      await roomAuth.supabase.from("room_logs").insert({
        room_id: roomId,
        event_type: "move_out",
        created_at: new Date().toISOString(),
      });
      return NextResponse.json({ success: true });
    }

    if (action === "final_move_out") {
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;
      const roomAuth = await requireAdminPermission(req, "room.edit");
      if ("error" in roomAuth) return roomAuth.error;

      const tenantId = String(body?.tenantId ?? "");
      const roomId = String(body?.roomId ?? "");
      const payload = body?.payload ?? {};
      const { error } = await auth.supabase.from("tenants").update(payload).eq("id", tenantId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      const moveOutDate =
        payload?.move_out_date ? String(payload.move_out_date) : new Date().toISOString().slice(0, 10);
      const { data: openLog } = await auth.supabase
        .from("room_tenant_logs")
        .select("id")
        .eq("room_id", roomId)
        .eq("tenant_id", tenantId)
        .is("move_out_date", null)
        .order("move_in_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (openLog?.id) {
        await auth.supabase
          .from("room_tenant_logs")
          .update({ move_out_date: moveOutDate, updated_at: new Date().toISOString() })
          .eq("id", openLog.id);
      }

      await roomAuth.supabase.from("rooms").update({ status: "available" }).eq("id", roomId);
      await roomAuth.supabase.from("room_logs").insert({
        room_id: roomId,
        event_type: "move_out",
        created_at: new Date().toISOString(),
      });

      const { error: deleteError } = await auth.supabase.from("tenants").delete().eq("id", tenantId);
      if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
  }
}
