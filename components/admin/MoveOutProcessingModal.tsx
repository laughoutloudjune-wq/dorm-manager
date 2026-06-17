"use client";

import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Modal } from "@/components/ui/Modal";
import { createClient } from "@/lib/supabase-client";
import { MoveOutTab } from "./MoveOutTab";
import type { MoveOutTabForm, TenantSnapshot } from "./MoveOutTab";
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
  const [form, setForm] = useState<MoveOutTabForm>({
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
  const [useProrate, setUseProrate] = useState(false);
  const [isMovingOut, setIsMovingOut] = useState(false);
  const [isCancellingMoveOut, setIsCancellingMoveOut] = useState(false);

  // SWR fetcher
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
        .order("start_date", { ascending: false })
    ]);

    if (tenantRes.error) throw new Error(tenantRes.error.message);
    
    const tenant = tenantRes.data;
    setForm(prev => ({
      ...prev,
      full_name: tenant.full_name,
      advance_rent_amount: tenant.advance_rent_amount || 0,
      security_deposit_amount: tenant.security_deposit_amount || 0,
    }));
    setForfeitDeposit(tenant.forfeit_security_deposit || false);

    return {
      tenant: tenantRes.data,
      unpaidInvoices: invoicesRes.data || [],
      rates: ratesRes.data || { electricity_rate: 0, water_rate: 0 },
      moveOutRequests: requestsRes.data || [],
      invoiceHistory: invoiceHistoryRes.data || []
    };
  };

  const { data, error, isLoading, mutate } = useSWR(
    isOpen && tenantId ? `move-out-processing-${tenantId}` : null,
    fetcher,
    { revalidateOnFocus: false } // Prevent resetting form on focus
  );

  const callTenantsAction = async (action: string, body: any = {}) => {
    const res = await fetch("/api/admin/tenants/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...body }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error ?? `Action ${action} failed`);
    }
    return res.json();
  };

  const manageMoveOutRequest = async (requestStatus: "approved" | "rejected") => {
    if (!data?.moveOutRequests?.[0]) return;
    try {
      await callTenantsAction("manage_move_out_request", {
        requestId: data.moveOutRequests[0].id,
        requestStatus,
        approvedMoveOutDate: requestStatus === "approved" ? form.move_out_request_date : null,
        adminNote: data.moveOutRequests[0].admin_note ?? null,
      });
      toast.success(requestStatus === "approved" ? "อนุมัติคำขอย้ายออกเรียบร้อย" : "ปฏิเสธคำขอย้ายออกเรียบร้อย");
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
    const moveOutDate = form.final_move_out_date || new Date().toISOString().slice(0, 10);
    try {
      // Calculate meter data and deductions to send to action
      const prevElec = data?.invoiceHistory?.[0]?.electricity_reading_end ?? data?.tenant?.initial_electricity_reading ?? 0;
      const prevWater = data?.invoiceHistory?.[0]?.water_reading_end ?? data?.tenant?.initial_water_reading ?? 0;
      
      const meterData = {
        initial_electricity: prevElec,
        initial_water: prevWater,
        final_electricity: form.final_electricity_reading,
        final_water: form.final_water_reading,
      };
      
      const electricityUsage = Math.max(form.final_electricity_reading - prevElec, 0);
      const waterUsage = Math.max(form.final_water_reading - prevWater, 0);
      const utilityTotal = (electricityUsage * data!.rates.electricity_rate) + (waterUsage * data!.rates.water_rate);
      
      const unpaidInvoicesSubtotal = data?.unpaidInvoices?.reduce((sum: number, inv: any) => sum + Math.max(0, inv.total_amount - (inv.paid_amount || 0)), 0) || 0;
      const additionalFeesTotal = moveOutFeeLines.reduce((sum, line) => sum + line.amount, 0);
      
      const totalDeductions = unpaidInvoicesSubtotal + utilityTotal + additionalFeesTotal; // basic calc for now, backend will do more
      const finalRefund = (forfeitDeposit ? 0 : form.security_deposit_amount) + form.advance_rent_amount - totalDeductions;

      await callTenantsAction("final_move_out", {
        tenantId,
        forfeitDeposit,
        moveOutDate,
        meterData,
        moveOutFeeLines,
        totalDeductions,
        finalRefund,
        abandon: false,
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

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="ดำเนินการย้ายออก (Move Out Processing)"
      size="4xl"
    >
      <div className="p-4 md:p-6">
        {isLoading && (
          <div className="animate-pulse space-y-4">
            <div className="h-8 w-1/3 rounded bg-slate-200" />
            <div className="h-32 w-full rounded bg-slate-200" />
            <div className="h-64 w-full rounded bg-slate-200" />
          </div>
        )}
        {error && (
          <div className="rounded-lg bg-red-50 p-4 text-red-600">
            เกิดข้อผิดพลาด: {error.message}
          </div>
        )}
        {data && (
          <MoveOutTab
            activeTenant={data.tenant}
            activeMoveOutRequest={data.moveOutRequests?.[0] || null}
            rates={data.rates}
            form={form}
            setForm={setForm}
            forfeitDeposit={forfeitDeposit}
            setForfeitDeposit={setForfeitDeposit}
            moveOutFeeLines={moveOutFeeLines}
            setMoveOutFeeLines={setMoveOutFeeLines}
            useProrate={useProrate}
            setUseProrate={setUseProrate}
            latestPrevElectricity={
              data.invoiceHistory?.[0]?.electricity_reading_end ??
              data.tenant.initial_electricity_reading ?? 0
            }
            latestPrevWater={
              data.invoiceHistory?.[0]?.water_reading_end ??
              data.tenant.initial_water_reading ?? 0
            }
            tenantInvoiceHistory={data.invoiceHistory}
            outstandingMoveOutInvoices={data.unpaidInvoices}
            unpaidInvoicesSubtotal={data.unpaidInvoices?.reduce((sum: number, inv: any) => sum + Math.max(0, inv.total_amount - (inv.paid_amount || 0)), 0) || 0}
            latestBilledEndYmd={(() => {
              const lastNormal = data.invoiceHistory?.find((inv: any) => inv.status !== "draft");
              return lastNormal?.end_date ? String(lastNormal.end_date).slice(0, 10) : null;
            })()}
            tailDaysAfterBilledPeriod={(() => {
              const moveOutDateObj = form.final_move_out_date ? new Date(form.final_move_out_date) : new Date();
              const billingDay = Math.max(1, Math.min(28, Number(data.rates.billing_day) || 25));
              const lastNormal = data.invoiceHistory?.find((inv: any) => inv.status !== "draft");
              const masterStartDateObj = lastNormal?.end_date ? new Date(lastNormal.end_date) : new Date(moveOutDateObj.getFullYear(), moveOutDateObj.getMonth() - 1, billingDay);
              
              let currentEnd = new Date(masterStartDateObj);
              currentEnd.setMonth(currentEnd.getMonth() + 1);
              let tempStart = new Date(masterStartDateObj);
              while (currentEnd <= moveOutDateObj) {
                tempStart = new Date(currentEnd);
                currentEnd.setMonth(currentEnd.getMonth() + 1);
              }
              const msPerDay = 86400000;
              const tempStartUtc = Date.UTC(tempStart.getFullYear(), tempStart.getMonth(), tempStart.getDate());
              const moveOutUtc = Date.UTC(moveOutDateObj.getFullYear(), moveOutDateObj.getMonth(), moveOutDateObj.getDate());
              return Math.floor((moveOutUtc - tempStartUtc) / msPerDay);
            })()}
            appliedMoveOutRentBase={(() => {
              const moveOutDateObj = form.final_move_out_date ? new Date(form.final_move_out_date) : new Date();
              const billingDay = Math.max(1, Math.min(28, Number(data.rates.billing_day) || 25));
              const lastNormal = data.invoiceHistory?.find((inv: any) => inv.status !== "draft");
              const masterStartDateObj = lastNormal?.end_date ? new Date(lastNormal.end_date) : new Date(moveOutDateObj.getFullYear(), moveOutDateObj.getMonth() - 1, billingDay);
              
              let currentEnd = new Date(masterStartDateObj);
              currentEnd.setMonth(currentEnd.getMonth() + 1);
              let fullMonths = 0;
              while (currentEnd <= moveOutDateObj) {
                fullMonths++;
                currentEnd.setMonth(currentEnd.getMonth() + 1);
              }
              const roomPrice = Array.isArray(data.tenant.rooms) ? toNumber(data.tenant.rooms[0]?.price_month) : toNumber(data.tenant.rooms?.price_month);
              return roomPrice * fullMonths;
            })()}
            roomNumber={Array.isArray(data.tenant.rooms) ? data.tenant.rooms[0]?.room_number : data.tenant.rooms?.room_number || ""}
            canEditTenant={true}
            isSavingTenant={false}
            isMovingOut={isMovingOut}
            isCancellingMoveOut={isCancellingMoveOut}
            onApprove={() => manageMoveOutRequest("approved")}
            onDecline={() => manageMoveOutRequest("rejected")}
            onCancelMoveOut={cancelMoveOutProcess}
            onSave={() => toast.success("Draft saved")}
            onPrint={() => window.print()}
            onConfirmMoveOut={confirmMoveOut}
            onAbandonRoom={abandonRoom}
          />
        )}
      </div>
    </Modal>
  );
}
