import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";
import { dailyRentRate } from "@/lib/invoice-utils";

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
  // Same fixed-30-day, floor-down-to-whole-baht convention as calculateProratedRentByBillingDay
  // (lib/invoice-utils.ts) — this used to divide unrounded, giving a different total than
  // the other two proration paths for the same scenario.
  const dailyOldRate = dailyRentRate(oldRoomRate);
  const dailyNewRate = dailyRentRate(newRoomRate);

  return {
    oldRoomAmount: dailyOldRate * oldRoomDays,
    newRoomAmount: dailyNewRate * newRoomDays,
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

      let tenantError = null;
      if (previousTenant) {
        const { error } = await auth.supabase.from("tenants").update(payload).eq("id", tenantId);
        tenantError = error;
      } else {
        const { error } = await auth.supabase.from("tenants").insert(payload);
        tenantError = error;
      }
      if (tenantError) return NextResponse.json({ error: tenantError.message }, { status: 500 });

      const effectiveTenantId = tenantId;
      const moveInDate = payload?.move_in_date 
        ? String(payload.move_in_date) 
        : (previousTenant?.move_in_date ? String(previousTenant.move_in_date) : null);
      const fullName = payload?.full_name 
        ? String(payload.full_name) 
        : (previousTenant?.full_name ? String(previousTenant.full_name) : null);

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
        const { error: closeOldLogError } = await auth.supabase
          .from("room_tenant_logs")
          .update({ move_out_date: closeDate, updated_at: new Date().toISOString() })
          .eq("room_id", String(previousTenant.room_id))
          .eq("tenant_id", tenantId)
          .is("move_out_date", null);
        if (closeOldLogError) {
          return NextResponse.json({ error: closeOldLogError.message }, { status: 500 });
        }

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
          const { error: transferInsertError } = await auth.supabase
            .from("tenant_room_transfers")
            .insert(transferInsert);
          if (transferInsertError) {
            return NextResponse.json({ error: transferInsertError.message }, { status: 500 });
          }
        }
      }

      if (shouldLogMoveIn) {
        const { error: moveInLogError } = await auth.supabase.from("room_tenant_logs").upsert(
          {
            room_id: roomId,
            tenant_id: effectiveTenantId || null,
            tenant_name: fullName,
            move_in_date: transferPayload?.transfer_date ? String(transferPayload.transfer_date) : moveInDate,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "room_id,tenant_id,move_in_date" }
        );
        if (moveInLogError) {
          return NextResponse.json({ error: moveInLogError.message }, { status: 500 });
        }
      }

      if (roomId) {
        const { error: roomStatusError } = await auth.supabase
          .from("rooms")
          .update({ status: "occupied" })
          .eq("id", roomId);
        if (roomStatusError) {
          return NextResponse.json({ error: roomStatusError.message }, { status: 500 });
        }
        const { error: roomLogError } = await auth.supabase.from("room_logs").insert({
          room_id: roomId,
          event_type: "move_in",
          created_at: new Date().toISOString(),
        });
        if (roomLogError) {
          console.warn("room_logs insert failed:", roomLogError.message);
        }
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

      const tenantId = String(body?.tenantId ?? "");
      const roomId = String(body?.roomId ?? "");
      const payload = body?.payload ?? {};
      const moveOutDate = payload?.move_out_date
        ? String(payload.move_out_date)
        : new Date().toISOString().slice(0, 10);
      const updateTenantPayload = {
        ...payload,
        status: "inactive",
        move_out_date: moveOutDate,
      };

      const { error } = await auth.supabase
        .from("tenants")
        .update(updateTenantPayload)
        .eq("id", tenantId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      const { data: openLog, error: openLogError } = await auth.supabase
        .from("room_tenant_logs")
        .select("id")
        .eq("room_id", roomId)
        .eq("tenant_id", tenantId)
        .is("move_out_date", null)
        .order("move_in_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (openLogError) return NextResponse.json({ error: openLogError.message }, { status: 500 });
      if (openLog?.id) {
        const { error: closeLogError } = await auth.supabase
          .from("room_tenant_logs")
          .update({ move_out_date: moveOutDate, updated_at: new Date().toISOString() })
          .eq("id", openLog.id);
        if (closeLogError) return NextResponse.json({ error: closeLogError.message }, { status: 500 });
      }

      const { error: roomStatusError } = await auth.supabase
        .from("rooms")
        .update({ status: "available" })
        .eq("id", roomId);
      if (roomStatusError) return NextResponse.json({ error: roomStatusError.message }, { status: 500 });

      const { error: roomLogError } = await auth.supabase.from("room_logs").insert({
        room_id: roomId,
        event_type: "move_out",
        created_at: new Date().toISOString(),
      });
      if (roomLogError) {
        // Non-fatal: room is already freed; the journal entry is only for reporting.
        console.warn("room_logs insert failed:", roomLogError.message);
      }
      return NextResponse.json({ success: true });
    }

    if (action === "manage_move_out_request") {
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;

      const requestId = String(body?.requestId ?? "");
      const requestStatus = String(body?.requestStatus ?? "");
      const approvedMoveOutDate = body?.approvedMoveOutDate
        ? String(body.approvedMoveOutDate)
        : null;
      const adminNote = body?.adminNote != null ? String(body.adminNote) : null;

      if (!requestId || !requestStatus) {
        return NextResponse.json({ error: "Missing requestId or requestStatus." }, { status: 400 });
      }

      const allowedStatuses = new Set(["requested", "approved", "rejected", "completed", "cancelled"]);
      if (!allowedStatuses.has(requestStatus)) {
        return NextResponse.json({ error: "Invalid request status." }, { status: 400 });
      }

      const { data: requestRow, error: requestFetchError } = await auth.supabase
        .from("move_out_requests")
        .select("id,tenant_id")
        .eq("id", requestId)
        .maybeSingle();

      if (requestFetchError) {
        return NextResponse.json({ error: requestFetchError.message }, { status: 500 });
      }
      if (!requestRow?.id) {
        return NextResponse.json({ error: "Move-out request not found." }, { status: 404 });
      }

      const nowIso = new Date().toISOString();
      const updatePayload: Record<string, unknown> = {
        status: requestStatus,
        admin_note: adminNote,
        updated_at: nowIso,
      };
      if (requestStatus === "approved") {
        updatePayload.approved_move_out_date = approvedMoveOutDate;
      }

      const { error: updateRequestError } = await auth.supabase
        .from("move_out_requests")
        .update(updatePayload)
        .eq("id", requestId);

      if (updateRequestError) {
        return NextResponse.json({ error: updateRequestError.message }, { status: 500 });
      }

      if (requestStatus === "approved" && approvedMoveOutDate) {
        const tenantId = String(requestRow.tenant_id);

        const { error: updateTenantError } = await auth.supabase
          .from("tenants")
          .update({ move_out_date: approvedMoveOutDate })
          .eq("id", tenantId);

        if (updateTenantError) {
          return NextResponse.json({ error: updateTenantError.message }, { status: 500 });
        }

      }

      return NextResponse.json({ success: true });
    }

    if (action === "final_move_out") {
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;

      const tenantId = String(body?.tenantId ?? "");
      const roomId = String(body?.roomId ?? "");
      const payload = body?.payload ?? {};
      const {
        forfeitDeposit,
        forfeit_security_deposit,
        useProrate = true,
        meterData: extractedMeterData,
        moveOutFeeLines: extractedMoveOutFeeLines,
        ...restPayload
      } = payload;
      
      const isForfeit = forfeitDeposit ?? forfeit_security_deposit ?? false;
      const moveOutDate =
        payload?.move_out_date ? String(payload.move_out_date) : new Date().toISOString().slice(0, 10);

      // Fetch tenant + room data and compute the whole settlement BEFORE touching
      // the tenant/room/logs below. The invoice insert used to happen last, so a
      // failure there (e.g. a missing column) still left the tenant marked
      // inactive and the room freed with no settlement invoice ever created —
      // an orphaned record with no way to recover the numbers that were entered.
      // Now nothing is mutated until the invoice is safely in the database.
      const { data: tenant, error: tenantFetchError } = await auth.supabase
        .from("tenants")
        .select("id,room_id,advance_rent_amount,security_deposit_amount,rooms(id,price_month,room_number)")
        .eq("id", tenantId)
        .maybeSingle();
      if (tenantFetchError) {
        return NextResponse.json({ error: tenantFetchError.message }, { status: 500 });
      }
      if (!tenant?.id) {
        return NextResponse.json({ error: "Tenant not found." }, { status: 404 });
      }

      const { data: settings } = await auth.supabase.from("settings").select("*").maybeSingle();
      const billingDay = Math.max(1, Math.min(28, Number(settings?.billing_day) || 25));
      const dueDay = Math.max(1, Math.min(28, Number(settings?.due_day) || 10));

      const { data: lastInvoice } = await auth.supabase
        .from("invoices")
        .select("end_date")
        .eq("tenant_id", tenantId)
        .neq("status", "draft")
        .order("start_date", { ascending: false })
        .limit(1)
        .maybeSingle();

      const moveOutDateObj = new Date(moveOutDate);
      let masterStartDateObj = lastInvoice?.end_date ? new Date(lastInvoice.end_date) : new Date(moveOutDateObj.getFullYear(), moveOutDateObj.getMonth() - 1, billingDay);
      
      // Calculate full months and prorate days
      // E.g., start: May 25, moveOut: June 28 -> 1 full month + 3 days
      // or start: June 25, moveOut: June 28 -> 0 full month + 3 days
      let currentEnd = new Date(masterStartDateObj);
      currentEnd.setMonth(currentEnd.getMonth() + 1);
      
      let fullMonths = 0;
      let tempStart = new Date(masterStartDateObj);
      while (currentEnd <= moveOutDateObj) {
        fullMonths++;
        tempStart = new Date(currentEnd);
        currentEnd.setMonth(currentEnd.getMonth() + 1);
      }
      
      // Calculate remaining prorate days
      const msPerDay = 86400000;
      const tempStartUtc = Date.UTC(tempStart.getFullYear(), tempStart.getMonth(), tempStart.getDate());
      const moveOutUtc = Date.UTC(moveOutDateObj.getFullYear(), moveOutDateObj.getMonth(), moveOutDateObj.getDate());
      const prorateDays = Math.floor((moveOutUtc - tempStartUtc) / msPerDay); // Exclusive of start date

      const roomRel = Array.isArray(tenant?.rooms) ? tenant?.rooms[0] : tenant?.rooms;
      const priceMonth = toNumber(roomRel?.price_month ?? 0);
      const dailyRate = dailyRentRate(priceMonth);

      const baseRent = useProrate ? (priceMonth * fullMonths) : 0;
      const proratedRent = useProrate ? dailyRate * prorateDays : 0;
      const totalRent = baseRent + proratedRent;

      // Utilities
      const meterData = payload?.meterData ?? {};
      const electricityUsage = Math.max(toNumber(meterData.final_electricity) - toNumber(meterData.initial_electricity), 0);
      const waterUsage = Math.max(toNumber(meterData.final_water) - toNumber(meterData.initial_water), 0);
      
      const elecRate = toNumber(settings?.electricity_rate ?? 0);
      const waterRate = toNumber(settings?.water_rate ?? 0);
      const electricityBill = electricityUsage * elecRate;
      const waterBill = waterUsage * waterRate;

      // Additional Fees
      const moveOutFeeLines = Array.isArray(payload?.moveOutFeeLines) ? payload.moveOutFeeLines : [];
      let additionalFeesTotal = 0;
      const additionalBreakdown = moveOutFeeLines.map((line: any) => {
        const amt = toNumber(line.amount);
        additionalFeesTotal += amt;
        return {
          item_type: "custom",
          label: line.label || "ค่าใช้จ่ายเพิ่มเติม",
          amount: amt,
        };
      });

      if (proratedRent > 0) {
        additionalBreakdown.unshift({
          item_type: "prorate_rent",
          label: `ค่าเช่าส่วนเกิน ${prorateDays} วัน (Pro-rate)`,
          amount: proratedRent,
        });
        additionalFeesTotal += proratedRent;
      }

      // Deductions
      const checkForfeit = Boolean(payload?.forfeitDeposit ?? payload?.forfeit_security_deposit);
      const depositRefund = checkForfeit ? 0 : toNumber(tenant?.security_deposit_amount ?? 0);
      const advanceRentRefund = toNumber(tenant?.advance_rent_amount ?? 0);
      const totalDiscount = depositRefund + advanceRentRefund;

      const totalAmount = baseRent + waterBill + electricityBill + additionalFeesTotal - totalDiscount;

      const toYmd = (d: Date) => d.toISOString().slice(0, 10);
      const dueDateObj = new Date(moveOutDateObj.getFullYear(), moveOutDateObj.getMonth(), moveOutDateObj.getDate() + 7);

      // Save the Master Final Invoice
      const { error: finalInvoiceError } = await auth.supabase.from("invoices").insert({
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        room_id: roomId,
        status: "pending",
        start_date: toYmd(masterStartDateObj),
        end_date: moveOutDate,
        issue_date: new Date().toISOString().slice(0, 10),
        due_date: toYmd(dueDateObj),
        rent_amount: baseRent,
        water_bill: waterBill,
        electricity_bill: electricityBill,
        common_fee: 0,
        discount_amount: totalDiscount,
        late_fee_amount: 0,
        carry_forward_amount: 0,
        additional_fees_total: additionalFeesTotal,
        additional_fees_breakdown: additionalBreakdown,
        total_amount: totalAmount,
        paid_amount: 0,
        electricity_reading_start: toNumber(meterData.initial_electricity),
        electricity_reading_end: toNumber(meterData.final_electricity),
        water_reading_start: toNumber(meterData.initial_water),
        water_reading_end: toNumber(meterData.final_water),
        notes: checkForfeit ? "ย้ายออก (ริบเงินประกัน)" : "ย้ายออก (Final Statement)",
        created_at: new Date().toISOString(),
      });
      if (finalInvoiceError) {
        return NextResponse.json({ error: finalInvoiceError.message }, { status: 500 });
      }

      // The settlement invoice exists now — safe to mutate tenant/room state.
      const updatePayload = {
        ...restPayload,
        forfeit_security_deposit: isForfeit,
        status: "inactive",
        room_id: null,
      };
      const { error: tenantUpdateError } = await auth.supabase
        .from("tenants")
        .update(updatePayload)
        .eq("id", tenantId);
      if (tenantUpdateError) return NextResponse.json({ error: tenantUpdateError.message }, { status: 500 });

      const { data: openLog, error: openLogError } = await auth.supabase
        .from("room_tenant_logs")
        .select("id")
        .eq("room_id", roomId)
        .eq("tenant_id", tenantId)
        .is("move_out_date", null)
        .order("move_in_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (openLogError) return NextResponse.json({ error: openLogError.message }, { status: 500 });
      if (openLog?.id) {
        const { error: closeLogError } = await auth.supabase
          .from("room_tenant_logs")
          .update({ move_out_date: moveOutDate, updated_at: new Date().toISOString() })
          .eq("id", openLog.id);
        if (closeLogError) return NextResponse.json({ error: closeLogError.message }, { status: 500 });
      }

      const { error: roomStatusError } = await auth.supabase
        .from("rooms")
        .update({ status: "available" })
        .eq("id", roomId);
      if (roomStatusError) return NextResponse.json({ error: roomStatusError.message }, { status: 500 });

      const { error: roomLogError } = await auth.supabase.from("room_logs").insert({
        room_id: roomId,
        event_type: "move_out",
        created_at: new Date().toISOString(),
      });
      if (roomLogError) {
        console.warn("room_logs insert failed:", roomLogError.message);
      }

      const { error: requestsError } = await auth.supabase
        .from("move_out_requests")
        .update({ status: "completed", updated_at: new Date().toISOString(), actual_move_out_date: moveOutDate })
        .eq("tenant_id", tenantId)
        .in("status", ["requested", "approved"]);
      if (requestsError) return NextResponse.json({ error: requestsError.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    if (action === "cancel_move_out_process") {
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;

      const tenantId = String(body?.tenantId ?? "");
      if (!tenantId) {
        return NextResponse.json({ error: "Missing tenantId." }, { status: 400 });
      }

      const { data: tenantRow, error: tenantFetchError } = await auth.supabase
        .from("tenants")
        .select("id,status")
        .eq("id", tenantId)
        .maybeSingle();

      if (tenantFetchError) {
        return NextResponse.json({ error: tenantFetchError.message }, { status: 500 });
      }
      if (!tenantRow?.id) {
        return NextResponse.json({ error: "Tenant not found." }, { status: 404 });
      }
      if (String(tenantRow.status) !== "active") {
        return NextResponse.json(
          { error: "ยกเลิกได้เฉพาะผู้เช่าที่ยังสถานะ active" },
          { status: 400 }
        );
      }

      const nowIso = new Date().toISOString();

      const { error: clearDateError } = await auth.supabase
        .from("tenants")
        .update({ move_out_date: null, updated_at: nowIso })
        .eq("id", tenantId)
        .eq("status", "active");

      if (clearDateError) {
        return NextResponse.json({ error: clearDateError.message }, { status: 500 });
      }

      const { error: cancelRequestsError } = await auth.supabase
        .from("move_out_requests")
        .update({ status: "cancelled", updated_at: nowIso })
        .eq("tenant_id", tenantId)
        .in("status", ["requested", "approved"]);

      if (cancelRequestsError) {
        return NextResponse.json({ error: cancelRequestsError.message }, { status: 500 });
      }

      return NextResponse.json({ success: true });
    }

    if (action === "abandon_room") {
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;

      const tenantId = String(body?.tenantId ?? "");
      const forfeitDeposit = Boolean(body?.forfeitDeposit);
      const moveOutDate = body?.moveOutDate
        ? String(body.moveOutDate)
        : new Date().toISOString().slice(0, 10);

      if (!tenantId) {
        return NextResponse.json({ error: "Missing tenantId." }, { status: 400 });
      }

      // Fetch tenant with room info
      const { data: tenant, error: tenantErr } = await auth.supabase
        .from("tenants")
        .select("id,room_id,advance_rent_amount,security_deposit_amount,status,rooms(id,price_month,room_number)")
        .eq("id", tenantId)
        .maybeSingle();

      if (tenantErr) return NextResponse.json({ error: tenantErr.message }, { status: 500 });
      if (!tenant?.id) return NextResponse.json({ error: "Tenant not found." }, { status: 404 });
      if (String(tenant.status) !== "active") {
        return NextResponse.json({ error: "ผู้เช่าไม่ได้อยู่ในสถานะ active" }, { status: 400 });
      }

      const nowIso = new Date().toISOString();

      // Build available credit pool
      let remainingCredit = toNumber(tenant.advance_rent_amount ?? 0);
      if (!forfeitDeposit) {
        remainingCredit += toNumber(tenant.security_deposit_amount ?? 0);
      }

      // Fetch all unpaid invoices for this tenant ordered by due_date asc
      const { data: unpaidInvoices, error: invErr } = await auth.supabase
        .from("invoices")
        .select("id,total_amount,paid_amount,status")
        .eq("tenant_id", tenantId)
        .in("status", ["pending", "overdue", "partial", "verifying", "draft"])
        .order("due_date", { ascending: true });

      if (invErr) return NextResponse.json({ error: invErr.message }, { status: 500 });

      // Apply credit to invoices in order. Each update is checked — if one fails
      // partway through, we stop immediately rather than continuing to "spend"
      // remainingCredit against invoices that never actually got written.
      for (const inv of unpaidInvoices ?? []) {
        const outstanding = Math.max(0, toNumber(inv.total_amount) - toNumber(inv.paid_amount));
        if (outstanding <= 0) continue;

        if (remainingCredit >= outstanding) {
          // Fully pay this invoice
          remainingCredit -= outstanding;
          const { error: payError } = await auth.supabase
            .from("invoices")
            .update({
              paid_amount: toNumber(inv.total_amount),
              status: "paid",
              updated_at: nowIso,
              notes: "ชำระโดยเครดิตจากการทิ้งห้อง (Abandon Room)",
            })
            .eq("id", inv.id);
          if (payError) return NextResponse.json({ error: payError.message }, { status: 500 });
        } else if (remainingCredit > 0) {
          // Partially pay then cancel remainder
          const newPaid = toNumber(inv.paid_amount) + remainingCredit;
          remainingCredit = 0;
          const { error: partialPayError } = await auth.supabase
            .from("invoices")
            .update({
              paid_amount: newPaid,
              status: "cancelled",
              updated_at: nowIso,
              notes: "ชำระบางส่วนโดยเครดิตจากการทิ้งห้อง แล้วยกเลิกส่วนที่เหลือ",
            })
            .eq("id", inv.id);
          if (partialPayError) return NextResponse.json({ error: partialPayError.message }, { status: 500 });
        } else {
          // No credit left — cancel the invoice
          const { error: cancelError } = await auth.supabase
            .from("invoices")
            .update({
              status: "cancelled",
              updated_at: nowIso,
              notes: "ยกเลิกเนื่องจากผู้เช่าทิ้งห้อง (Abandon Room)",
            })
            .eq("id", inv.id);
          if (cancelError) return NextResponse.json({ error: cancelError.message }, { status: 500 });
        }
      }

      // Mark tenant inactive and clear room
      const { error: abandonTenantError } = await auth.supabase
        .from("tenants")
        .update({
          status: "inactive",
          move_out_date: moveOutDate,
          forfeit_security_deposit: forfeitDeposit,
          room_id: null,
          updated_at: nowIso,
        })
        .eq("id", tenantId);
      if (abandonTenantError) {
        return NextResponse.json({ error: abandonTenantError.message }, { status: 500 });
      }

      // Close the open room_tenant_log
      const roomId = String(tenant.room_id ?? "");
      if (roomId) {
        const { data: openLog, error: openLogError } = await auth.supabase
          .from("room_tenant_logs")
          .select("id")
          .eq("room_id", roomId)
          .eq("tenant_id", tenantId)
          .is("move_out_date", null)
          .order("move_in_date", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (openLogError) return NextResponse.json({ error: openLogError.message }, { status: 500 });
        if (openLog?.id) {
          const { error: closeLogError } = await auth.supabase
            .from("room_tenant_logs")
            .update({ move_out_date: moveOutDate, updated_at: nowIso })
            .eq("id", openLog.id);
          if (closeLogError) return NextResponse.json({ error: closeLogError.message }, { status: 500 });
        }

        // Free the room and log the event
        const { error: roomStatusError } = await auth.supabase
          .from("rooms")
          .update({ status: "available" })
          .eq("id", roomId);
        if (roomStatusError) return NextResponse.json({ error: roomStatusError.message }, { status: 500 });

        const { error: roomLogError } = await auth.supabase.from("room_logs").insert({
          room_id: roomId,
          event_type: "move_out",
          created_at: nowIso,
        });
        if (roomLogError) {
          console.warn("room_logs insert failed:", roomLogError.message);
        }
      }

      // Mark any pending move-out requests as completed
      const { error: closeRequestsError } = await auth.supabase
        .from("move_out_requests")
        .update({ status: "completed", updated_at: nowIso, actual_move_out_date: moveOutDate })
        .eq("tenant_id", tenantId)
        .in("status", ["requested", "approved"]);
      if (closeRequestsError) {
        return NextResponse.json({ error: closeRequestsError.message }, { status: 500 });
      }

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
  }
}
