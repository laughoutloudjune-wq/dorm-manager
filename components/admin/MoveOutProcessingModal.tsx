"use client";

import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Modal } from "@/components/ui/Modal";
import { createClient } from "@/lib/supabase-client";
import { MoveOutWizard } from "./MoveOutWizard";
import type { MoveOutWizardForm } from "./MoveOutWizard";
import type { MoveOutFeeLine } from "@/types";
import { toNumber } from "@/lib/format";

type MoveOutProcessingModalProps = {
  isOpen: boolean;
  onClose: () => void;
  tenantId: string | null;
  onSuccess?: () => void;
};

export function MoveOutProcessingModal({
  isOpen,
  onClose,
  tenantId,
  onSuccess,
}: MoveOutProcessingModalProps) {
  const supabase = createClient();
  const [form, setForm] = useState<MoveOutWizardForm>({
    full_name: "",
    advance_rent_amount: 0,
    security_deposit_amount: 0,
    final_electricity_reading: 0,
    final_water_reading: 0,
    move_out_request_date: new Date().toISOString().slice(0, 10),
    final_move_out_date: new Date().toISOString().slice(0, 10),
  });

  const [forfeitDeposit, setForfeitDeposit] = useState(false);
  const [moveOutFeeLines, setMoveOutFeeLines] = useState<MoveOutFeeLine[]>([]);
  const [isMovingOut, setIsMovingOut] = useState(false);
  const [isCancellingMoveOut, setIsCancellingMoveOut] = useState(false);

  // ── Data fetching ──────────────────────────────────────────────────────────

  const fetcher = async () => {
    if (!tenantId) return null;

    const [tenantRes, invoicesRes, ratesRes, requestsRes, invoiceHistoryRes] = await Promise.all([
      supabase
        .from("tenants")
        .select("*, rooms(room_number, price_month, buildings(name))")
        .eq("id", tenantId)
        .single(),
      supabase
        .from("invoices")
        .select("*")
        .eq("tenant_id", tenantId)
        .in("status", ["pending", "overdue", "partial", "verifying", "draft"]),
      supabase.from("settings").select("*").single(),
      supabase
        .from("move_out_requests")
        .select("*")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false }),
      supabase
        .from("invoices")
        .select("*")
        .eq("tenant_id", tenantId)
        .order("start_date", { ascending: false }),
    ]);

    if (tenantRes.error) throw new Error(tenantRes.error.message);

    const tenant = tenantRes.data;

    const { data: meterData } = await supabase
      .from("meter_readings")
      .select("current_electricity,current_water")
      .eq("room_id", tenant.room_id)
      .order("reading_month", { ascending: false })
      .limit(1)
      .maybeSingle();

    const prevElec =
      meterData?.current_electricity ??
      tenant.initial_electricity_reading ??
      0;
    const prevWater =
      meterData?.current_water ??
      tenant.initial_water_reading ??
      0;

    setForm((prev) => ({
      ...prev,
      full_name: tenant.full_name,
      advance_rent_amount: tenant.advance_rent_amount || 0,
      security_deposit_amount: tenant.security_deposit_amount || 0,
      // Initialize finals to previous reading so usage = 0 until admin changes them
      final_electricity_reading: prev.final_electricity_reading || prevElec,
      final_water_reading: prev.final_water_reading || prevWater,
    }));
    setForfeitDeposit(tenant.forfeit_security_deposit || false);

    return {
      tenant: tenantRes.data,
      unpaidInvoices: invoicesRes.data || [],
      rates: ratesRes.data || { electricity_rate: 0, water_rate: 0 },
      moveOutRequests: requestsRes.data || [],
      invoiceHistory: invoiceHistoryRes.data || [],
    };
  };

  const { data, error, isLoading, mutate } = useSWR(
    isOpen && tenantId ? `move-out-processing-${tenantId}` : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  // ── API helpers ───────────────────────────────────────────────────────────

  const callTenantsAction = async (action: string, body: any = {}) => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");

    const res = await fetch("/api/admin/tenants/actions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action, ...body }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error ?? `Action ${action} failed`);
    }
    return res.json();
  };

  // ── Actions ───────────────────────────────────────────────────────────────

  const manageMoveOutRequest = async (requestStatus: "approved" | "rejected") => {
    if (!data?.moveOutRequests?.[0]) return;
    try {
      await callTenantsAction("manage_move_out_request", {
        requestId: data.moveOutRequests[0].id,
        requestStatus,
        approvedMoveOutDate:
          requestStatus === "approved" ? form.move_out_request_date : null,
        adminNote: data.moveOutRequests[0].admin_note ?? null,
      });
      toast.success(
        requestStatus === "approved"
          ? "อนุมัติคำขอย้ายออกเรียบร้อย"
          : "ปฏิเสธคำขอย้ายออกเรียบร้อย"
      );
      mutate();
      if (onSuccess) onSuccess();
    } catch (error: any) {
      toast.error(error?.message ?? "จัดการคำขอย้ายออกไม่สำเร็จ");
    }
  };

  const cancelMoveOutProcess = async () => {
    setIsCancellingMoveOut(true);
    try {
      await callTenantsAction("cancel_move_out_process", { tenantId });
      toast.success("ยกเลิกกระบวนการย้ายออกแล้ว");
      mutate();
      if (onSuccess) onSuccess();
      onClose();
    } catch (error: any) {
      toast.error(error?.message ?? "ยกเลิกกระบวนการย้ายออกไม่สำเร็จ");
    } finally {
      setIsCancellingMoveOut(false);
    }
  };

  const confirmMoveOut = async () => {
    setIsMovingOut(true);
    const moveOutDate =
      form.final_move_out_date || new Date().toISOString().slice(0, 10);
    try {
      // Previous meter readings (source of truth from fetched data)
      const prevElec =
        data?.invoiceHistory?.[0]?.electricity_reading_end ??
        data?.tenant?.initial_electricity_reading ??
        0;
      const prevWater =
        data?.invoiceHistory?.[0]?.water_reading_end ??
        data?.tenant?.initial_water_reading ??
        0;

      // ── FIX: nest meterData inside `payload` so the API handler can read it ──
      await callTenantsAction("final_move_out", {
        tenantId,
        payload: {
          forfeitDeposit,
          move_out_date: moveOutDate,
          meterData: {
            initial_electricity: prevElec,
            initial_water: prevWater,
            final_electricity: form.final_electricity_reading,
            final_water: form.final_water_reading,
          },
          moveOutFeeLines,
        },
      });
      toast.success("บันทึกการย้ายออกเรียบร้อย");
      if (onSuccess) onSuccess();
      onClose();
    } catch (error: any) {
      toast.error(error?.message ?? "ยืนยันการย้ายออกไม่สำเร็จ");
    } finally {
      setIsMovingOut(false);
    }
  };

  const abandonRoom = async (isForfeit: boolean, moveOutDate: string) => {
    try {
      await callTenantsAction("abandon_room", {
        tenantId,
        forfeitDeposit: isForfeit,
        moveOutDate,
      });
      toast.success("ดำเนินการผู้เช่าทิ้งห้องเรียบร้อยแล้ว");
      if (onSuccess) onSuccess();
      onClose();
    } catch (error: any) {
      toast.error(error?.message ?? "ดำเนินการทิ้งห้องไม่สำเร็จ");
    }
  };

  if (!isOpen) return null;

  const prevElec =
    data?.invoiceHistory?.[0]?.electricity_reading_end ??
    data?.tenant?.initial_electricity_reading ??
    0;
  const prevWater =
    data?.invoiceHistory?.[0]?.water_reading_end ??
    data?.tenant?.initial_water_reading ??
    0;

  const billingDay = Math.max(
    1,
    Math.min(28, Number(data?.rates?.billing_day) || 25)
  );

  const tailDaysAfterBilledPeriod = (() => {
    const moveOutDateObj = form.final_move_out_date
      ? new Date(form.final_move_out_date)
      : new Date();
    const lastNormal = data?.invoiceHistory?.[0];
    const masterStartDateObj = lastNormal?.end_date
      ? new Date(lastNormal.end_date)
      : new Date(
          moveOutDateObj.getFullYear(),
          moveOutDateObj.getMonth() - 1,
          billingDay
        );

    let currentEnd = new Date(masterStartDateObj);
    currentEnd.setMonth(currentEnd.getMonth() + 1);
    let tempStart = new Date(masterStartDateObj);
    while (currentEnd <= moveOutDateObj) {
      tempStart = new Date(currentEnd);
      currentEnd.setMonth(currentEnd.getMonth() + 1);
    }
    const msPerDay = 86400000;
    const tempStartUtc = Date.UTC(
      tempStart.getFullYear(),
      tempStart.getMonth(),
      tempStart.getDate()
    );
    const moveOutUtc = Date.UTC(
      moveOutDateObj.getFullYear(),
      moveOutDateObj.getMonth(),
      moveOutDateObj.getDate()
    );
    return Math.floor((moveOutUtc - tempStartUtc) / msPerDay);
  })();

  const appliedMoveOutRentBase = (() => {
    const moveOutDateObj = form.final_move_out_date
      ? new Date(form.final_move_out_date)
      : new Date();
    const lastNormal = data?.invoiceHistory?.[0];
    const masterStartDateObj = lastNormal?.end_date
      ? new Date(lastNormal.end_date)
      : new Date(
          moveOutDateObj.getFullYear(),
          moveOutDateObj.getMonth() - 1,
          billingDay
        );

    let currentEnd = new Date(masterStartDateObj);
    currentEnd.setMonth(currentEnd.getMonth() + 1);
    let fullMonths = 0;
    while (currentEnd <= moveOutDateObj) {
      fullMonths++;
      currentEnd.setMonth(currentEnd.getMonth() + 1);
    }
    const roomPrice = Array.isArray(data?.tenant?.rooms)
      ? toNumber(data?.tenant?.rooms[0]?.price_month)
      : toNumber(data?.tenant?.rooms?.price_month);
    return roomPrice * fullMonths;
  })();

  const latestBilledEndYmd = (() => {
    const lastNormal = data?.invoiceHistory?.[0];
    return lastNormal?.end_date
      ? String(lastNormal.end_date).slice(0, 10)
      : null;
  })();

  const roomNumber = Array.isArray(data?.tenant?.rooms)
    ? data?.tenant?.rooms[0]?.room_number
    : data?.tenant?.rooms?.room_number || "";

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="ดำเนินการย้ายออก"
      size="4xl"
    >
      <div className="p-4 md:p-6">
        {isLoading && (
          <div className="flex flex-col gap-4 animate-pulse">
            <div className="h-6 w-48 rounded-lg bg-slate-200" />
            <div className="h-32 w-full rounded-2xl bg-slate-100" />
            <div className="h-48 w-full rounded-2xl bg-slate-100" />
          </div>
        )}
        {error && (
          <div className="rounded-2xl bg-red-50 border border-red-200 p-4 text-red-600 text-sm">
            เกิดข้อผิดพลาด: {error.message}
          </div>
        )}
        {data && (
          <MoveOutWizard
            activeTenant={data.tenant}
            activeMoveOutRequest={data.moveOutRequests?.[0] || null}
            rates={data.rates}
            form={form}
            setForm={setForm}
            forfeitDeposit={forfeitDeposit}
            setForfeitDeposit={setForfeitDeposit}
            moveOutFeeLines={moveOutFeeLines}
            setMoveOutFeeLines={setMoveOutFeeLines}
            latestPrevElectricity={prevElec}
            latestPrevWater={prevWater}
            tenantInvoiceHistory={data.invoiceHistory}
            outstandingMoveOutInvoices={data.unpaidInvoices}
            unpaidInvoicesSubtotal={
              data.unpaidInvoices?.reduce(
                (sum: number, inv: any) =>
                  sum + Math.max(0, inv.total_amount - (inv.paid_amount || 0)),
                0
              ) || 0
            }
            latestBilledEndYmd={latestBilledEndYmd}
            tailDaysAfterBilledPeriod={tailDaysAfterBilledPeriod}
            appliedMoveOutRentBase={appliedMoveOutRentBase}
            roomNumber={roomNumber}
            canEditTenant={true}
            isMovingOut={isMovingOut}
            isCancellingMoveOut={isCancellingMoveOut}
            onApprove={() => manageMoveOutRequest("approved")}
            onDecline={() => manageMoveOutRequest("rejected")}
            onCancelMoveOut={cancelMoveOutProcess}
            onConfirmMoveOut={confirmMoveOut}
            onAbandonRoom={abandonRoom}
          />
        )}
      </div>
    </Modal>
  );
}
