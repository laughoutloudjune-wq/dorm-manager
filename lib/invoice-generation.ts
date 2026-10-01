import type { SupabaseClient } from "@supabase/supabase-js";
import { toLocalDateString, toNumber, formatMoney } from "@/lib/format";
import { computeLateFeeSnapshot, syncInvoiceLedger } from "@/lib/invoice-ledger";
import { bangkokYmd } from "@/lib/move-out-notice";
import {
  resolveGenerationFeeModel,
  v2MonthlyMoneyColumns,
  type FeeModel,
} from "@/lib/fee-model-v2";
import {
  clampDay,
  buildRuleBreakdown,
  calculateWaterBillWithMinimum,
  buildTransferWaterBreakdown,
  calculateInvoiceTransferRentProration,
  serializeTransferBreakdownRows,
  buildLateFeeLineDetail,
  type AdditionalFee,
} from "@/lib/invoice-utils";

export type GenerateInvoicesParams = {
  year: number;
  month: number;
  /**
   * Compute everything without writing anything — no insert, no late-fee
   * freeze, no overdue sync. Used to verify this function against real
   * historical data (see dryRunIncludeExisting) before it's ever wired up
   * to actually run, and to preview a not-yet-generated month.
   */
  dryRun?: boolean;
  /**
   * Only ever honored when dryRun is also true. A real run (and a plain dry
   * run) always skips rooms that already have an invoice for the period —
   * this bypasses that skip so a dry run can recompute a month that's
   * ALREADY been generated and diff the result against what's actually
   * stored. Never allowed to affect a real, writing run.
   */
  dryRunIncludeExisting?: boolean;
  /**
   * Preview a run under a specific fee model. Only ever honored when dryRun
   * is also true (see resolveGenerationFeeModel): a real run always decides
   * by today's Bangkok date against V2_FEE_MODEL_CUTOVER_DATE.
   */
  forceFeeModel?: FeeModel | null;
};

export type GenerateInvoicesDryRunResult = {
  dryRun: true;
  /** The fee model the bills in insertPayload were built under. */
  feeModel: FeeModel;
  insertPayload: any[];
  missingTenantRoomNumbers: string[];
  existingRoomCount: number;
  carryForwardTenantCount: number;
  carryForwardPendingTotal: number;
};

export type GenerateInvoicesResult = {
  dryRun?: false;
  success: true;
  feeModel: FeeModel;
  generated: number;
  errorMessage: string | null;
  alerts: string[];
  bookkeepingFailures: string[];
  carryForwardNotice: { tenantCount: number; pendingTotal: number } | null;
};

/**
 * Server-side port of generateInvoices() from
 * lib/hooks/use-invoices-state.ts — the last remaining C1 item
 * (docs/audit/2026-09-29-system-audit-detailed.md): monthly invoice
 * generation had no server-side version at all and ran entirely in the
 * browser with the anon key. Every computation below is copied verbatim
 * from that function; only the plumbing around it changed (thrown errors
 * instead of setError + early return, a direct call to syncInvoiceLedger
 * instead of an HTTP round-trip to itself).
 *
 * Pulled out into its own module (rather than left inline in
 * app/api/admin/invoices/actions/route.ts) specifically so it can be
 * called directly — with the service-role client, dryRun: true, and
 * dryRunIncludeExisting: true — from a throwaway verification script
 * against real historical data, without needing a real admin session.
 */
export async function generateInvoicesForPeriod(
  supabase: SupabaseClient,
  params: GenerateInvoicesParams
): Promise<GenerateInvoicesDryRunResult | GenerateInvoicesResult> {
  const { year, month } = params;
  if (!year || !month) {
    throw new Error("Missing year or month.");
  }
  const dryRun = Boolean(params.dryRun);
  const dryRunIncludeExisting = dryRun && Boolean(params.dryRunIncludeExisting);

  // Switch-over (design A6/B8, decision C3): bills CREATED on/after the
  // cut-over use the new rules — own charges only, no carry-forward, no
  // relayed late-fee line, nothing locked or billed on older bills. Before
  // the cut-over every line below runs exactly as it always has (legacy).
  const feeModel = resolveGenerationFeeModel({
    todayBangkok: bangkokYmd(),
    dryRun,
    forceFeeModel: params.forceFeeModel ?? null,
  });
  const isV2 = feeModel === "v2";

  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0);
  const monthKey = toLocalDateString(new Date(year, month - 1, 1));

  const { data: settings, error: settingsError } = await supabase
    .from("settings")
    .select(
      "water_rate,electricity_rate,common_fee,water_min_units,water_min_price,additional_fees,additional_discounts,billing_day,due_day,late_fee_start_day,late_fee_per_day"
    )
    .eq("id", 1)
    .single();

  if (settingsError || !settings) {
    throw new Error(settingsError?.message ?? "Settings not found");
  }

  const billingDay = clampDay((settings as any).billing_day ?? 1);
  const dueDay = clampDay((settings as any).due_day ?? 5);
  const lateFeeStartDay = clampDay((settings as any).late_fee_start_day ?? 6);
  const lateFeePerDay = toNumber((settings as any).late_fee_per_day ?? 0);
  const issueDateText = toLocalDateString(new Date(year, month - 1, billingDay));
  const generatedDueDateText = toLocalDateString(new Date(year, month, dueDay));
  const generatedLateFeeStartDateText = toLocalDateString(new Date(year, month, lateFeeStartDay));

  const { data: occupiedRooms, error: roomError } = await supabase
    .from("rooms")
    .select("id,room_number,price_month")
    .eq("status", "occupied");
  if (roomError) throw new Error(roomError.message);

  // Vacated-but-unsettled tenants: the OLD "vacate" move-out step frees the
  // room immediately but deliberately leaves room_id set on the tenant row
  // until final_move_out settles them (CLAUDE.md's move-out flow). They still
  // owe rent for this period, so they must keep getting billed like any other
  // occupied room until settlement clears room_id.
  //
  // The NEW unlock_room function (design B5/A5) produces the same
  // inactive + room_id-still-set shape, but sets handover_date — and under
  // the new rules billing stops the moment a tenant is unlocked, not at
  // settlement. Excluding handover_date IS NOT NULL here is what makes that
  // true; without it, an unlocked tenant kept getting billed exactly like an
  // old-style vacated one.
  const { data: pendingSettlementTenants, error: pendingTenantError } = await supabase
    .from("tenants")
    .select("id,room_id,move_in_date,rooms(room_number,price_month)")
    .eq("status", "inactive")
    .not("room_id", "is", null)
    .is("handover_date", null);
  if (pendingTenantError) throw new Error(pendingTenantError.message);

  if ((!occupiedRooms || occupiedRooms.length === 0) && (!pendingSettlementTenants || pendingSettlementTenants.length === 0)) {
    throw new Error("No occupied rooms found.");
  }

  const roomIds = (occupiedRooms ?? []).map((room: any) => room.id);

  const { data: activeTenants, error: tenantError } = await supabase
    .from("tenants")
    .select("id,room_id,full_name,move_in_date,move_out_date")
    .eq("status", "active")
    .in("room_id", roomIds.length > 0 ? roomIds : ["00000000-0000-0000-0000-000000000000"]);
  if (tenantError) throw new Error(tenantError.message);

  const tenantByRoom = new Map<string, any>();
  for (const tenant of activeTenants ?? []) {
    if (!tenantByRoom.has(tenant.room_id)) tenantByRoom.set(tenant.room_id, tenant);
  }

  const missingTenantRooms = (occupiedRooms ?? []).filter((room: any) => !tenantByRoom.has(room.id));

  const billingTenants = (occupiedRooms ?? [])
    .map((room: any) => {
      const tenant = tenantByRoom.get(room.id);
      if (!tenant) return null;
      return {
        id: tenant.id,
        room_id: room.id,
        move_in_date: tenant.move_in_date,
        rooms: { room_number: room.room_number, price_month: room.price_month },
      };
    })
    .filter(Boolean) as any[];

  // Merge in the pending-settlement tenants. Skip any whose room_id has
  // since been reassigned to a new active tenant (already covered via
  // tenantByRoom) — their remaining charges belong solely to their own
  // final_move_out settlement, not another recurring invoice.
  for (const tenant of pendingSettlementTenants ?? []) {
    const roomId = String((tenant as any).room_id ?? "");
    if (!roomId || tenantByRoom.has(roomId)) continue;
    const roomRel = Array.isArray((tenant as any).rooms) ? (tenant as any).rooms[0] : (tenant as any).rooms;
    if (!roomRel) continue;
    billingTenants.push({
      id: (tenant as any).id,
      room_id: roomId,
      move_in_date: (tenant as any).move_in_date,
      rooms: { room_number: roomRel.room_number, price_month: roomRel.price_month },
    });
    if (!roomIds.includes(roomId)) roomIds.push(roomId);
  }

  const transferByTenant = new Map<string, any>();
  if (billingTenants.length > 0) {
    const tenantIds = billingTenants.map((tenant: any) => String(tenant.id));
    const { data: transfers } = await supabase
      .from("tenant_room_transfers")
      .select(
        "tenant_id,from_room_id,to_room_id,transfer_date,billing_month,old_electric_usage,old_water_usage,old_rent_amount,new_rent_amount,new_prev_electricity,new_prev_water"
      )
      .eq("billing_month", toLocalDateString(startDate))
      .in("tenant_id", tenantIds);
    for (const row of transfers ?? []) {
      const key = String((row as any).tenant_id);
      const previous = transferByTenant.get(key);
      if (!previous) {
        transferByTenant.set(key, row);
        continue;
      }
      const prevDate = String((previous as any).transfer_date ?? "");
      const currDate = String((row as any).transfer_date ?? "");
      if (currDate > prevDate) transferByTenant.set(key, row);
    }
  }

  const transferRoomRateMap = new Map<string, number>();
  for (const room of occupiedRooms ?? []) {
    transferRoomRateMap.set(String((room as any).id), toNumber((room as any).price_month));
  }
  const missingTransferRoomIds = Array.from(
    new Set(
      Array.from(transferByTenant.values()).flatMap((row: any) => [
        String(row?.from_room_id ?? ""),
        String(row?.to_room_id ?? ""),
      ])
    )
  ).filter((roomId) => roomId && !transferRoomRateMap.has(roomId));
  if (missingTransferRoomIds.length > 0) {
    const { data: extraTransferRooms, error: extraTransferRoomsError } = await supabase
      .from("rooms")
      .select("id,price_month")
      .in("id", missingTransferRoomIds);
    if (extraTransferRoomsError) throw new Error(extraTransferRoomsError.message);
    for (const room of extraTransferRooms ?? []) {
      transferRoomRateMap.set(String((room as any).id), toNumber((room as any).price_month));
    }
  }

  const { data: existingInvoices, error: existingError } = await supabase
    .from("invoices")
    .select("room_id")
    .eq("start_date", toLocalDateString(startDate))
    .eq("end_date", toLocalDateString(endDate))
    .in("room_id", roomIds);
  if (existingError) throw new Error(existingError.message);

  const existingRoomIds = new Set((existingInvoices ?? []).map((row: any) => row.room_id));
  const tenantsToGenerate = dryRunIncludeExisting
    ? billingTenants
    : billingTenants.filter((tenant: any) => !existingRoomIds.has(tenant.room_id));

  if (!dryRun) {
    await syncInvoiceLedger(supabase, { beforeStartDate: toLocalDateString(startDate) });
  }

  const tenantIdsToGenerate = tenantsToGenerate.map((tenant: any) => String(tenant.id));
  // v2: nothing is relayed from older bills, so they are not even read. An
  // older unpaid bill stays on its own row and is shown NEXT TO the new one
  // (A3), never added into it.
  const { data: previousUnpaidInvoices, error: previousUnpaidError } =
    !isV2 && tenantIdsToGenerate.length > 0
      ? await supabase
          .from("invoices")
          .select(
            "id,tenant_id,start_date,due_date,total_amount,paid_amount,status,late_fee_amount,late_fee_per_day,late_fee_start_date,waived_late_fee_amount,locked_late_fee_amount,carry_forward_amount,late_fee_billed_at"
          )
          .in("tenant_id", tenantIdsToGenerate)
          .lt("start_date", toLocalDateString(startDate))
          .or("status.in.(pending,partial,overdue,verifying),and(status.eq.paid,late_fee_billed_at.is.null)")
          .order("start_date", { ascending: true })
      : { data: [], error: null as any };
  if (previousUnpaidError) throw new Error(previousUnpaidError.message);

  const carryForwardByTenant = new Map<string, any[]>();
  for (const row of (previousUnpaidInvoices ?? []) as any[]) {
    const rawOutstanding = Math.max(0, toNumber(row.total_amount) - toNumber(row.paid_amount));
    const carryAmt = toNumber(row.carry_forward_amount);
    const outstanding = carryAmt > 0 ? Math.max(0, rawOutstanding - carryAmt) : rawOutstanding;
    const generationDateText = issueDateText;
    const tenantId = String(row.tenant_id ?? "");
    if (!tenantId) continue;

    const lateFeeSnapshot = computeLateFeeSnapshot(
      {
        status: row.status ?? null,
        late_fee_start_date: row.late_fee_start_date ?? null,
        late_fee_per_day: row.late_fee_per_day ?? 0,
        waived_late_fee_amount: row.waived_late_fee_amount ?? 0,
        locked_late_fee_amount: row.locked_late_fee_amount ?? null,
      },
      generationDateText
    );

    if (outstanding <= 0 && lateFeeSnapshot.amount <= 0) continue;

    const currentRows = carryForwardByTenant.get(tenantId) ?? [];
    currentRows.push({
      ...row,
      outstanding_amount: outstanding,
      base_outstanding_amount: outstanding,
      snapshot_as_of: lateFeeSnapshot.asOf ?? generationDateText,
      snapshot_late_fee_amount: lateFeeSnapshot.amount,
      snapshot_days_overdue: lateFeeSnapshot.days,
      snapshot_daily_rate: toNumber(row.late_fee_per_day ?? 0),
    });
    carryForwardByTenant.set(tenantId, currentRows);
  }

  const { data: readings } = await supabase
    .from("meter_readings")
    .select("room_id,electricity_usage,water_usage,usage,current_electricity,current_water")
    .eq("reading_month", monthKey)
    .in("room_id", roomIds.length ? roomIds : ["00000000-0000-0000-0000-000000000000"]);
  const readingMap = new Map((readings ?? []).map((row: any) => [row.room_id, row]));

  const additionalFees = Array.isArray((settings as any).additional_fees)
    ? ((settings as any).additional_fees as AdditionalFee[])
    : [];
  const discountRules = Array.isArray((settings as any).additional_discounts)
    ? ((settings as any).additional_discounts as AdditionalFee[])
    : [];

  const insertPayload = tenantsToGenerate.map((tenant: any) => {
    const roomRel = Array.isArray(tenant.rooms) ? tenant.rooms[0] : tenant.rooms;
    const reading = readingMap.get(tenant.room_id) ?? ({} as any);
    const transfer = transferByTenant.get(String(tenant.id));
    const hasTransferToThisRoom = !!transfer && String((transfer as any).to_room_id ?? "") === String(tenant.room_id);

    const newRoomElecUnits =
      hasTransferToThisRoom && toNumber((transfer as any).new_prev_electricity) > 0
        ? Math.max(0, toNumber(reading.current_electricity) - toNumber((transfer as any).new_prev_electricity))
        : toNumber(reading.electricity_usage);
    const newRoomWaterUnits =
      hasTransferToThisRoom && toNumber((transfer as any).new_prev_water) > 0
        ? Math.max(0, toNumber(reading.current_water) - toNumber((transfer as any).new_prev_water))
        : toNumber(reading.water_usage ?? reading.usage);
    const oldRoomElecUnits = hasTransferToThisRoom ? toNumber((transfer as any).old_electric_usage) : 0;
    const oldRoomWaterUnits = hasTransferToThisRoom ? toNumber((transfer as any).old_water_usage) : 0;
    const elecUnits = oldRoomElecUnits + newRoomElecUnits;
    const waterUnits = oldRoomWaterUnits + newRoomWaterUnits;

    const transferRentBreakdown = hasTransferToThisRoom
      ? calculateInvoiceTransferRentProration(
          toLocalDateString(startDate),
          toLocalDateString(endDate),
          String((transfer as any).transfer_date ?? issueDateText),
          tenant.move_in_date,
          toNumber(transferRoomRateMap.get(String((transfer as any).from_room_id ?? ""))),
          toNumber(transferRoomRateMap.get(String((transfer as any).to_room_id ?? "")))
        )
      : null;
    const rentAmount = transferRentBreakdown
      ? transferRentBreakdown.oldRentAmount + transferRentBreakdown.newRentAmount
      : toNumber(roomRel?.price_month);

    const elecBill = elecUnits * toNumber((settings as any).electricity_rate);
    const waterBill = calculateWaterBillWithMinimum(
      waterUnits,
      toNumber((settings as any).water_rate),
      toNumber((settings as any).water_min_units),
      toNumber((settings as any).water_min_price)
    );

    const additionalBreakdown = additionalFees.map((fee) => {
      const rate = toNumber(fee.value);
      let amount = 0;
      if (fee.calc_type === "fixed") amount = rate;
      if (fee.calc_type === "electricity_units") amount = elecUnits * rate;
      if (fee.calc_type === "water_units") amount = waterUnits * rate;
      const unit = fee.calc_type === "electricity_units" ? elecUnits : fee.calc_type === "water_units" ? waterUnits : 1;
      return {
        label: fee.label,
        detail: fee.label,
        calc_type: fee.calc_type,
        rate,
        unit,
        price_per_unit: rate,
        total_amount: amount,
        amount,
      };
    });

    const additionalTotal = additionalBreakdown.reduce((sum, fee) => sum + toNumber(fee.amount), 0);
    const discountBreakdown = buildRuleBreakdown(discountRules, elecUnits, waterUnits);
    const discountAmount = discountBreakdown.reduce((sum, fee) => sum + toNumber(fee.amount), 0);

    // Principal is never merged: an older unpaid invoice's own rent/water/
    // electric stays on ITS OWN row, untouched by this run. Only the late
    // fee still relays forward — calculated once per source invoice, at
    // whichever generation cycle first finds it still unbilled, then billed
    // here as its own line item and locked so it can never be billed twice
    // or keep growing on the source. No invoice_carry_forwards link is
    // written for this.
    const carryForwardRows = carryForwardByTenant.get(String(tenant.id)) ?? [];
    const lateFeeBreakdown = carryForwardRows
      .filter((row: any) => toNumber(row.snapshot_late_fee_amount) > 0 && row.late_fee_billed_at == null)
      .map((row: any) => {
        const daysOverdue = toNumber(row.snapshot_days_overdue);
        const dailyRate = toNumber(row.snapshot_daily_rate);
        const detail = buildLateFeeLineDetail(String(row.start_date ?? ""), daysOverdue, dailyRate, row.snapshot_as_of);
        return {
          item_type: "late_fee_line",
          source_invoice_id: row.id,
          label: detail,
          detail,
          unit: daysOverdue,
          price_per_unit: dailyRate,
          total_amount: toNumber(row.snapshot_late_fee_amount),
          amount: toNumber(row.snapshot_late_fee_amount),
          days_overdue: daysOverdue,
          daily_rate: dailyRate,
          snapshot_as_of: row.snapshot_as_of,
          original_amount: toNumber(row.snapshot_late_fee_amount),
          waived_amount: 0,
        };
      });
    const carriedLateFeeTotal = lateFeeBreakdown.reduce((sum: number, item: any) => sum + toNumber(item.total_amount), 0);

    const commonFee = toNumber((settings as any).common_fee);
    const totalAmount = rentAmount + waterBill + elecBill + commonFee + additionalTotal + carriedLateFeeTotal - discountAmount;
    // v2: the bill's own charges through the one totals engine, every relay
    // term zero. (carryForwardByTenant is empty for v2, so lateFeeBreakdown
    // is already [] — this does not depend on that.)
    const v2Money = isV2
      ? v2MonthlyMoneyColumns({
          rent: rentAmount,
          water: waterBill,
          electricity: elecBill,
          commonFee,
          fees: additionalTotal,
          discount: discountAmount,
        })
      : null;

    const electricityRate = toNumber((settings as any).electricity_rate);
    const waterRate = toNumber((settings as any).water_rate);
    const waterMinUnits = toNumber((settings as any).water_min_units);
    const waterMinPrice = toNumber((settings as any).water_min_price);
    const oldElecBill = hasTransferToThisRoom ? oldRoomElecUnits * electricityRate : 0;
    const newElecBill = hasTransferToThisRoom ? newRoomElecUnits * electricityRate : 0;
    const waterBreakdownItems = hasTransferToThisRoom
      ? buildTransferWaterBreakdown(oldRoomWaterUnits, newRoomWaterUnits, waterRate, waterMinUnits, waterMinPrice)
      : [];

    const transferBreakdownRows = hasTransferToThisRoom
      ? serializeTransferBreakdownRows([
          { label: "วันที่ย้ายห้อง", value: String((transfer as any).transfer_date ?? "-") },
          {
            label: "ค่าเช่าห้องเดิม",
            value: formatMoney(toNumber(transferRentBreakdown?.oldRentAmount)),
            amount: toNumber(transferRentBreakdown?.oldRentAmount),
            editable: true,
            kind: "old_rent",
          },
          {
            label: "ค่าเช่าห้องใหม่",
            value: formatMoney(toNumber(transferRentBreakdown?.newRentAmount)),
            amount: toNumber(transferRentBreakdown?.newRentAmount),
            editable: true,
            kind: "new_rent",
          },
          ...waterBreakdownItems,
          {
            label: `ค่าไฟห้องเดิม (${oldRoomElecUnits} หน่วย)`,
            value: `${oldRoomElecUnits} หน่วย × ${formatMoney(electricityRate)} = ${formatMoney(oldElecBill)}`,
            amount: oldElecBill,
            kind: "old_elec",
          },
          {
            label: `ค่าไฟห้องใหม่ (${newRoomElecUnits} หน่วย)`,
            value: `${newRoomElecUnits} หน่วย × ${formatMoney(electricityRate)} = ${formatMoney(newElecBill)}`,
            amount: newElecBill,
            kind: "new_elec",
          },
        ])
      : [];

    if (v2Money) {
      return {
        tenant_id: tenant.id,
        room_id: tenant.room_id,
        issue_date: issueDateText,
        due_date: generatedDueDateText,
        start_date: toLocalDateString(startDate),
        end_date: toLocalDateString(endDate),
        rent_amount: rentAmount,
        water_bill: waterBill,
        electricity_bill: elecBill,
        common_fee: commonFee,
        discount_amount: v2Money.discount_amount,
        discount_breakdown: discountBreakdown,
        // Not a cache of anything yet: the live fee always comes from the
        // engine. Kept 0 so no legacy reader adds it to the total.
        late_fee_amount: v2Money.late_fee_amount,
        late_fee_per_day: lateFeePerDay,
        late_fee_start_date: generatedLateFeeStartDateText,
        carry_forward_amount: v2Money.carry_forward_amount,
        additional_fees_total: v2Money.additional_fees_total,
        additional_fees_breakdown: [...additionalBreakdown, ...transferBreakdownRows],
        total_amount: v2Money.total_amount,
        notes: null,
        status: "draft",
        fee_model: "v2",
        kind: "monthly",
      };
    }

    return {
      tenant_id: tenant.id,
      room_id: tenant.room_id,
      issue_date: issueDateText,
      due_date: generatedDueDateText,
      start_date: toLocalDateString(startDate),
      end_date: toLocalDateString(endDate),
      rent_amount: rentAmount,
      water_bill: waterBill,
      electricity_bill: elecBill,
      common_fee: commonFee,
      discount_amount: discountAmount,
      discount_breakdown: discountBreakdown,
      late_fee_amount: carriedLateFeeTotal,
      late_fee_per_day: lateFeePerDay,
      late_fee_start_date: generatedLateFeeStartDateText,
      carry_forward_amount: 0,
      additional_fees_total: additionalTotal + carriedLateFeeTotal,
      additional_fees_breakdown: [...lateFeeBreakdown, ...additionalBreakdown, ...transferBreakdownRows],
      total_amount: totalAmount,
      notes: null,
      status: "draft",
    };
  }) as any[];

  const generatedRoomIds = new Set(insertPayload.map((row: any) => row.room_id));

  if (dryRun) {
    const pendingTotal = [...carryForwardByTenant.values()].reduce(
      (sum, rows) => sum + rows.reduce((s: number, row: any) => s + toNumber(row.outstanding_amount), 0),
      0
    );
    return {
      dryRun: true,
      feeModel,
      insertPayload,
      missingTenantRoomNumbers: missingTenantRooms.map((room: any) => room.room_number),
      existingRoomCount: existingRoomIds.size,
      carryForwardTenantCount: carryForwardByTenant.size,
      carryForwardPendingTotal: pendingTotal,
    };
  }

  // Bookkeeping that fails AFTER the invoices are inserted used to be
  // silently overwritten by the alerts block that ran after it — these
  // survive to the end and are surfaced as their own field. Principal gets
  // none of this: an older invoice's own rent/water/electric is never
  // touched by this run, no matter what happens below — only the late-fee
  // freeze runs, and only for a source whose fee actually got billed onto
  // one of the invoices just created.
  const bookkeepingFailures: string[] = [];
  let noInvoicesMessage: string | null = null;
  if (insertPayload.length > 0) {
    const { data: insertedInvoices, error: insertError } = await supabase
      .from("invoices")
      .insert(insertPayload)
      .select("id,tenant_id");
    if (insertError) throw new Error(insertError.message);
    // v2: no late fee was relayed, so no older bill is frozen or marked billed.
    if (!isV2 && (insertedInvoices ?? []).length > 0) {
      const allSourceRows = (insertedInvoices ?? []).flatMap((row: any) =>
        (carryForwardByTenant.get(String(row.tenant_id ?? "")) ?? []).filter(
          (carryRow: any) => toNumber(carryRow.snapshot_late_fee_amount) > 0 && carryRow.late_fee_billed_at == null
        )
      );
      const nowIso = new Date().toISOString();
      for (const carryRow of allSourceRows) {
        const freezeAmount = toNumber(carryRow.snapshot_late_fee_amount);
        const freezeUpdate: Record<string, unknown> = { late_fee_billed_at: nowIso };
        if (carryRow.locked_late_fee_amount == null) {
          freezeUpdate.locked_late_fee_amount = freezeAmount;
        }
        const { error: freezeError } = await supabase.from("invoices").update(freezeUpdate).eq("id", carryRow.id);
        if (freezeError) {
          bookkeepingFailures.push(`ล็อก/บันทึกสถานะค่าปรับล่าช้าของบิลเดิมไม่สำเร็จ: ${freezeError.message}`);
        }
      }
    }
  } else {
    // Matches the original's behaviour exactly: this does NOT stop the
    // function — it still runs the audit below (missing-tenant rooms, rooms
    // that failed to bill) even when literally nothing was generated, since
    // that's precisely when an admin most needs to see why.
    noInvoicesMessage = "No new invoices generated. All rooms already have invoices for this period.";
  }

  const occupiedRoomIds = new Set<string>([
    ...(occupiedRooms ?? []).map((room: any) => String(room.id)),
    ...billingTenants.map((tenant: any) => String(tenant.room_id)),
  ]);
  const billedRoomIds = new Set<string>([...existingRoomIds, ...generatedRoomIds]);
  const roomNumberById = new Map<string, string>([
    ...(occupiedRooms ?? []).map((room: any) => [String(room.id), room.room_number] as [string, string]),
    ...billingTenants.map((tenant: any) => [String(tenant.room_id), tenant.rooms?.room_number] as [string, string]),
  ]);
  const notBilledRoomIds = [...occupiedRoomIds].filter((roomId) => !billedRoomIds.has(roomId));

  const alerts: string[] = [];
  if (existingRoomIds.size > 0 && insertPayload.length > 0) {
    alerts.push(`สร้างใบแจ้งหนี้ ${insertPayload.length} รายการแล้ว และข้าม ${existingRoomIds.size} ห้องที่มีใบแจ้งหนี้ในงวดนี้อยู่แล้ว`);
  }
  if (missingTenantRooms.length > 0) {
    const rooms = missingTenantRooms.map((room: any) => room.room_number).join(", ");
    alerts.push(`Occupied room(s) missing active tenant: ${rooms}`);
  }
  if (notBilledRoomIds.length > 0) {
    const rooms = notBilledRoomIds.map((roomId) => roomNumberById.get(roomId) ?? roomId).join(", ");
    alerts.push(`Billing audit failed. Occupied room(s) without invoice: ${rooms}`);
  }
  if (bookkeepingFailures.length > 0) {
    // Ahead of the audit alerts: these mean the ledger is inconsistent, not
    // merely that a room was skipped.
    alerts.unshift(...bookkeepingFailures);
  }

  const pendingTotal = [...carryForwardByTenant.values()].reduce(
    (sum, rows) => sum + rows.reduce((s: number, row: any) => s + toNumber(row.outstanding_amount), 0),
    0
  );
  const carryForwardNotice =
    carryForwardByTenant.size > 0 && pendingTotal > 0 ? { tenantCount: carryForwardByTenant.size, pendingTotal } : null;

  // Matches the original's precedence: the generic "nothing generated"
  // message only surfaces when there's nothing more specific to say — an
  // actual alert (missing tenant, failed audit) always wins.
  const errorMessage = alerts.length > 0 ? alerts.join(" | ") : noInvoicesMessage;

  return {
    success: true,
    feeModel,
    generated: insertPayload.length,
    errorMessage,
    alerts,
    bookkeepingFailures,
    carryForwardNotice,
  };
}
