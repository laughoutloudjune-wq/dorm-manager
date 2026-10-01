"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Page";
import { MoveOutWizard } from "./MoveOutWizard";
import type { MoveOutWizardForm } from "./MoveOutWizard";
import { getInvoiceOwnOutstanding } from "@/lib/invoice-ledger";
import { callTenantsAction } from "@/lib/tenants-action-client";
import { usePermissions } from "@/lib/use-permissions";

type MoveOutProcessingModalProps = {
  isOpen: boolean;
  onClose: () => void;
  tenantId: string | null;
  onSuccess?: () => void;
};

/**
 * The move-out dialog. Runs the two-step flow (CLAUDE.md "Move-out flow",
 * design doc A5/B5): unlock_room when the key comes back, then — any time
 * later — prepare_move_out_bill and settle_move_out. The old move_out /
 * final_move_out actions are no longer called from here.
 */
export function MoveOutProcessingModal({
  isOpen,
  onClose,
  tenantId,
  onSuccess,
}: MoveOutProcessingModalProps) {
  const { can, loading: permLoading } = usePermissions();
  const [form, setForm] = useState<MoveOutWizardForm>({
    full_name: "",
    final_electricity_reading: 0,
    final_water_reading: 0,
  });
  const [forfeitDeposit, setForfeitDeposit] = useState(false);
  const [isCancellingMoveOut, setIsCancellingMoveOut] = useState(false);
  const [autosaveStatus, setAutosaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  // Last known-persisted draft values, so the autosave effect can tell "the
  // admin changed something" apart from "the fetch just hydrated the form".
  const draftHydratedRef = useRef<{
    final_electricity_reading: number;
    final_water_reading: number;
    forfeit_security_deposit: boolean;
  } | null>(null);
  const hydratedTenantRef = useRef<string | null>(null);

  // ── Data fetching ──────────────────────────────────────────────────────────

  const fetcher = async () => {
    if (!tenantId) return null;
    // See get_move_out_data in app/api/admin/tenants/actions/route.ts.
    const result = await callTenantsAction("get_move_out_data", { tenantId });
    const tenant = result.tenant;
    const meterData = result.meterReading;

    // The latest meter_readings row for the room is the "previous reading"
    // shown next to the inputs (CLAUDE.md: never reconstruct it from invoice
    // history). prepare_move_out_bill picks its own baseline server-side and
    // reports it back in the breakdown.
    const prevElec = meterData?.current_electricity ?? tenant.initial_electricity_reading ?? 0;
    const prevWater = meterData?.current_water ?? tenant.initial_water_reading ?? 0;

    // Hydrate the form once per tenant; refetches after an action must not
    // overwrite readings the admin is typing.
    if (hydratedTenantRef.current !== tenant.id) {
      hydratedTenantRef.current = tenant.id;
      const elec = tenant.final_electricity_reading ?? prevElec ?? 0;
      const water = tenant.final_water_reading ?? prevWater ?? 0;
      setForm({ full_name: tenant.full_name, final_electricity_reading: elec, final_water_reading: water });
      setForfeitDeposit(Boolean(tenant.forfeit_security_deposit));
      draftHydratedRef.current = {
        final_electricity_reading: elec,
        final_water_reading: water,
        forfeit_security_deposit: Boolean(tenant.forfeit_security_deposit),
      };
    }

    return {
      tenant,
      unpaidInvoices: result.unpaidInvoices || [],
      moveOutRequests: result.moveOutRequests || [],
      invoiceHistory: result.invoiceHistory || [],
      prevElec,
      prevWater,
    };
  };

  const { data, error, isLoading, mutate } = useSWR(
    isOpen && tenantId ? `move-out-processing-${tenantId}` : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  // ── Autosave (key-return readings + forfeit choice) ─────────────────────────
  useEffect(() => {
    draftHydratedRef.current = null;
    hydratedTenantRef.current = null;
    setAutosaveStatus("idle");
  }, [isOpen, tenantId]);

  useEffect(() => {
    if (!isOpen || !tenantId) return;
    const lastSaved = draftHydratedRef.current;
    if (!lastSaved) return; // still hydrating
    if (isCancellingMoveOut) return;

    const current = {
      final_electricity_reading: form.final_electricity_reading,
      final_water_reading: form.final_water_reading,
      forfeit_security_deposit: forfeitDeposit,
    };
    const changed =
      current.final_electricity_reading !== lastSaved.final_electricity_reading ||
      current.final_water_reading !== lastSaved.final_water_reading ||
      current.forfeit_security_deposit !== lastSaved.forfeit_security_deposit;
    if (!changed) return;

    setAutosaveStatus("saving");
    const timeout = setTimeout(() => {
      void callTenantsAction("autosave_move_out_draft", { tenantId, payload: current })
        .then(() => {
          draftHydratedRef.current = current;
          setAutosaveStatus("saved");
        })
        .catch(() => setAutosaveStatus("idle"));
    }, 900);
    return () => clearTimeout(timeout);
  }, [
    isOpen,
    tenantId,
    form.final_electricity_reading,
    form.final_water_reading,
    forfeitDeposit,
    isCancellingMoveOut,
  ]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const refresh = async () => {
    await mutate();
    onSuccess?.();
  };

  const manageMoveOutRequest = async (requestStatus: "approved" | "rejected") => {
    if (!data?.moveOutRequests?.[0]) return;
    try {
      await callTenantsAction("manage_move_out_request", {
        requestId: data.moveOutRequests[0].id,
        requestStatus,
        adminNote: data.moveOutRequests[0].admin_note ?? null,
      });
      toast.success(requestStatus === "approved" ? "อนุมัติคำขอย้ายออกเรียบร้อย" : "ปฏิเสธคำขอย้ายออกเรียบร้อย");
      await refresh();
    } catch (error: any) {
      toast.error(error?.message ?? "จัดการคำขอย้ายออกไม่สำเร็จ");
    }
  };

  const cancelMoveOutProcess = async () => {
    setIsCancellingMoveOut(true);
    try {
      await callTenantsAction("cancel_move_out_process", { tenantId });
      toast.success("ยกเลิกกระบวนการย้ายออกแล้ว");
      await refresh();
      onClose();
    } catch (error: any) {
      toast.error(error?.message ?? "ยกเลิกกระบวนการย้ายออกไม่สำเร็จ");
    } finally {
      setIsCancellingMoveOut(false);
    }
  };

  const abandonRoom = async (isForfeit: boolean, moveOutDate: string) => {
    try {
      const result = await callTenantsAction("abandon_room", {
        tenantId,
        forfeitDeposit: isForfeit,
        moveOutDate,
      });
      const summary = result?.summary ?? {};
      const baht = (value: unknown) => Number(value ?? 0).toLocaleString("th-TH");
      const parts = [
        `ตัดชำระ ฿${baht(summary.creditApplied)}`,
        Number(summary.writtenOff ?? 0) > 0 ? `ตัดหนี้สูญ ฿${baht(summary.writtenOff)}` : "",
        Number(summary.refundableCredit ?? 0) > 0 ? `เหลือเครดิตคืนผู้เช่า ฿${baht(summary.refundableCredit)}` : "",
      ].filter(Boolean);
      toast.success(`ดำเนินการผู้เช่าทิ้งห้องเรียบร้อยแล้ว - ${parts.join(" · ")}`, { duration: 10000 });
      onSuccess?.();
      onClose();
    } catch (error: any) {
      toast.error(error?.message ?? "ดำเนินการทิ้งห้องไม่สำเร็จ");
    }
  };

  if (!isOpen) return null;

  const roomNumber = Array.isArray(data?.tenant?.rooms)
    ? data?.tenant?.rooms[0]?.room_number ?? ""
    : data?.tenant?.rooms?.room_number || "";

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="ดำเนินการย้ายออก"
      description={data?.tenant ? `${data.tenant.full_name}${roomNumber ? ` · ห้อง ${roomNumber}` : ""}` : undefined}
      size="2xl"
    >
      {isLoading && (
        <div className="flex animate-pulse flex-col gap-4">
          <div className="h-6 w-48 rounded-control bg-slate-200" />
          <div className="h-32 w-full rounded-card bg-slate-100" />
          <div className="h-48 w-full rounded-card bg-slate-100" />
        </div>
      )}
      {error && <Notice tone="danger">เกิดข้อผิดพลาด: {error.message}</Notice>}
      {data && autosaveStatus !== "idle" && (
        <p className="mb-3 text-right text-2xs text-slate-400">
          {autosaveStatus === "saving" ? "กำลังบันทึกอัตโนมัติ..." : "บันทึกอัตโนมัติแล้ว"}
        </p>
      )}
      {data && (
        <MoveOutWizard
          key={data.tenant.id}
          activeTenant={data.tenant}
          activeMoveOutRequest={data.moveOutRequests?.[0] || null}
          form={form}
          setForm={setForm}
          forfeitDeposit={forfeitDeposit}
          setForfeitDeposit={setForfeitDeposit}
          latestPrevElectricity={data.prevElec}
          latestPrevWater={data.prevWater}
          tenantInvoiceHistory={data.invoiceHistory}
          outstandingMoveOutInvoices={data.unpaidInvoices}
          unpaidInvoicesSubtotal={
            data.unpaidInvoices?.reduce((sum: number, inv: any) => sum + getInvoiceOwnOutstanding(inv), 0) || 0
          }
          roomNumber={roomNumber}
          canEditTenant={!permLoading && can("tenant.edit")}
          isCancellingMoveOut={isCancellingMoveOut}
          onApprove={() => manageMoveOutRequest("approved")}
          onDecline={() => manageMoveOutRequest("rejected")}
          onCancelMoveOut={cancelMoveOutProcess}
          onAbandonRoom={abandonRoom}
          onChanged={refresh}
          onDone={onClose}
        />
      )}
    </Modal>
  );
}
