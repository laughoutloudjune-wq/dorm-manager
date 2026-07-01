import React, { useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Loader2, ArrowRightLeft, Building2, CheckCircle2, ChevronRight, ChevronLeft, Save } from "lucide-react";
import { formatMoney, toNumber, ymdToLocalDate } from "@/lib/format";
import { calculateTransferRentProration, tenantRoomNumber, tenantRoomPrice, roomLabel } from "@/lib/tenant-utils";
import { RoomRow, SettingsRates, TenantRow } from "@/types";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase-client";

type MoveRoomWizardModalProps = {
  isOpen: boolean;
  onClose: () => void;
  activeTenant: TenantRow;
  rooms: RoomRow[];
  rates: SettingsRates;
  onSuccess: () => Promise<void>;
};

const STEPS = [
  { id: 1, label: "ห้องใหม่", icon: Building2, desc: "เลือกห้องและวันที่" },
  { id: 2, label: "ปิดยอดห้องเดิม", icon: ArrowRightLeft, desc: "มิเตอร์วันย้ายออก" },
  { id: 3, label: "เริ่มห้องใหม่", icon: CheckCircle2, desc: "มิเตอร์วันย้ายเข้า" },
  { id: 4, label: "สรุป", icon: Save, desc: "ตรวจสอบยอดและบันทึก" },
];

export function MoveRoomWizardModal({
  isOpen,
  onClose,
  activeTenant,
  rooms,
  rates,
  onSuccess,
}: MoveRoomWizardModalProps) {
  const [step, setStep] = useState(1);
  const [isSaving, setIsSaving] = useState(false);

  const [form, setForm] = useState({
    new_room_id: "",
    transfer_date: new Date().toISOString().slice(0, 10),
    old_prev_electricity: 0,
    old_curr_electricity: 0,
    old_prev_water: 0,
    old_curr_water: 0,
    new_curr_electricity: 0,
    new_curr_water: 0,
  });

  const roomsById = useMemo(() => {
    const map = new Map<string, RoomRow>();
    for (const r of rooms) map.set(r.id, r);
    return map;
  }, [rooms]);

  const oldRoomRate = tenantRoomPrice(activeTenant, roomsById);
  const newRoom = roomsById.get(form.new_room_id);
  const newRoomRate = newRoom?.price_month ?? 0;

  const transferProration = useMemo(
    () => calculateTransferRentProration(form.transfer_date, activeTenant.move_in_date, oldRoomRate, newRoomRate),
    [oldRoomRate, newRoomRate, form.transfer_date, activeTenant.move_in_date]
  );

  const transferOldElectricUsage = Math.max(0, toNumber(form.old_curr_electricity) - toNumber(form.old_prev_electricity));
  const transferOldWaterUsage = Math.max(0, toNumber(form.old_curr_water) - toNumber(form.old_prev_water));
  const transferOldUtility = transferOldElectricUsage * rates.electricity_rate + transferOldWaterUsage * rates.water_rate;
  
  const transferGrandTotal = transferProration.oldRentAmount + transferProration.newRentAmount + transferOldUtility;

  const handleConfirm = async () => {
    if (!form.new_room_id) {
      toast.error("กรุณาเลือกห้องใหม่");
      return;
    }
    setIsSaving(true);
    
    const payload = {
      tenant_id: activeTenant.id,
      from_room_id: activeTenant.room_id,
      to_room_id: form.new_room_id,
      transfer_date: form.transfer_date,
      billing_month: `${form.transfer_date.slice(0, 7)}-01`,
      old_prev_electricity: toNumber(form.old_prev_electricity),
      old_curr_electricity: toNumber(form.old_curr_electricity),
      old_prev_water: toNumber(form.old_prev_water),
      old_curr_water: toNumber(form.old_curr_water),
      new_prev_electricity: toNumber(form.new_curr_electricity),
      new_curr_electricity: toNumber(form.new_curr_electricity),
      new_prev_water: toNumber(form.new_curr_water),
      new_curr_water: toNumber(form.new_curr_water),
      old_electric_usage: transferOldElectricUsage,
      old_water_usage: transferOldWaterUsage,
      old_rent_amount: transferProration.oldRentAmount,
      new_rent_amount: transferProration.newRentAmount,
    };

    try {
      const { createClient } = await import("@/lib/supabase-client");
      const supabase = createClient();
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");

      const res = await fetch("/api/admin/tenants/actions", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: "save_tenant",
          payload: { id: activeTenant.id, room_id: form.new_room_id },
          roomId: form.new_room_id,
          transferPayload: payload,
        }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "บันทึกย้ายห้องไม่สำเร็จ");
      }
      toast.success("บันทึกการย้ายห้องกลางเดือนเรียบร้อย");
      await onSuccess();
      onClose();
    } catch (err: any) {
      toast.error(err.message || "เกิดข้อผิดพลาดในการย้ายห้อง");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`ย้ายห้อง: ${activeTenant.full_name}`} size="2xl">
      <div className="flex flex-col md:flex-row gap-6 min-h-[400px]">
        {/* ── Progress Rail ── */}
        <div className="w-full md:w-56 shrink-0 border-r border-slate-100 pr-6">
          <div className="flex flex-col gap-5 relative">
            {STEPS.map((s, index) => {
              const Icon = s.icon;
              const isActive = step === s.id;
              const isPast = step > s.id;
              return (
                <div key={s.id} className="relative flex items-start gap-3">
                  {index < STEPS.length - 1 && (
                    <div
                      className={`absolute left-[15px] top-8 h-[calc(100%+8px)] w-0.5 -translate-x-1/2 ${
                        isPast ? "bg-blue-600" : "bg-slate-200"
                      }`}
                    />
                  )}
                  <div
                    className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                      isActive
                        ? "border-blue-600 bg-blue-600 text-white shadow-sm shadow-blue-200"
                        : isPast
                          ? "border-blue-600 bg-white text-blue-600"
                          : "border-slate-200 bg-slate-50 text-slate-400"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="flex flex-col pt-1.5">
                    <span
                      className={`text-sm font-semibold leading-none ${
                        isActive ? "text-slate-900" : isPast ? "text-slate-700" : "text-slate-500"
                      }`}
                    >
                      {s.label}
                    </span>
                    <span className="mt-1 text-[11px] text-slate-500">{s.desc}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Step Content ── */}
        <div className="flex-1 flex flex-col justify-between">
          <div className="disabled:opacity-80 disabled:cursor-not-allowed">
            {step === 1 && (
              <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300">
                <h3 className="text-lg font-bold text-slate-800 border-b border-slate-100 pb-2">เลือกห้องและวันที่ย้าย</h3>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <label className="text-sm font-medium text-slate-700 block mb-1.5">ห้องใหม่</label>
                    <select
                      value={form.new_room_id}
                      onChange={(e) => setForm({ ...form, new_room_id: e.target.value })}
                      className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-base shadow-sm focus:border-blue-500 focus:ring-blue-500"
                    >
                      <option value="">-- เลือกห้อง --</option>
                      {rooms.filter(r => r.id !== activeTenant.room_id).map((room) => (
                        <option key={room.id} value={room.id}>
                          {roomLabel(room)} (฿{formatMoney(room.price_month ?? 0)}/ด.)
                        </option>
                      ))}
                    </select>
                  </div>
                  <Input
                    label="วันที่ย้ายเข้าห้องใหม่"
                    type="date"
                    value={form.transfer_date}
                    onChange={(e) => setForm({ ...form, transfer_date: e.target.value })}
                    className="text-base"
                  />
                </div>
                
                <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-4 text-sm text-slate-700">
                  <p className="font-semibold text-blue-900 mb-2">ข้อมูลการย้าย</p>
                  <p>ห้องเดิม: <span className="font-medium text-slate-900">{tenantRoomNumber(activeTenant, roomsById)}</span> (฿{formatMoney(oldRoomRate)})</p>
                  <p>ห้องใหม่: <span className="font-medium text-slate-900">{newRoom ? roomLabel(newRoom) : "-"}</span> (฿{formatMoney(newRoomRate)})</p>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300">
                <h3 className="text-lg font-bold text-slate-800 border-b border-slate-100 pb-2">ปิดยอดมิเตอร์ห้องเดิม</h3>
                <p className="text-sm text-slate-500">กรอกเลขมิเตอร์ ณ วันที่ย้ายออกเพื่อคิดค่าน้ำไฟของห้องเก่าในเดือนนี้</p>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-3 rounded-xl border border-slate-200 p-3 bg-white shadow-sm">
                    <p className="font-medium text-slate-700 border-b border-slate-100 pb-2">ไฟฟ้า (ห้องเดิม)</p>
                    <Input
                      label="เลขครั้งก่อน"
                      type="number"
                      value={form.old_prev_electricity}
                      onChange={(e) => setForm({ ...form, old_prev_electricity: toNumber(e.target.value) })}
                    />
                    <Input
                      label="เลขล่าสุด (วันย้าย)"
                      type="number"
                      value={form.old_curr_electricity}
                      onChange={(e) => setForm({ ...form, old_curr_electricity: toNumber(e.target.value) })}
                    />
                    <p className="text-sm text-slate-500 text-right">ใช้ไป {transferOldElectricUsage} หน่วย</p>
                  </div>
                  <div className="space-y-3 rounded-xl border border-slate-200 p-3 bg-white shadow-sm">
                    <p className="font-medium text-slate-700 border-b border-slate-100 pb-2">น้ำประปา (ห้องเดิม)</p>
                    <Input
                      label="เลขครั้งก่อน"
                      type="number"
                      value={form.old_prev_water}
                      onChange={(e) => setForm({ ...form, old_prev_water: toNumber(e.target.value) })}
                    />
                    <Input
                      label="เลขล่าสุด (วันย้าย)"
                      type="number"
                      value={form.old_curr_water}
                      onChange={(e) => setForm({ ...form, old_curr_water: toNumber(e.target.value) })}
                    />
                    <p className="text-sm text-slate-500 text-right">ใช้ไป {transferOldWaterUsage} หน่วย</p>
                  </div>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300">
                <h3 className="text-lg font-bold text-slate-800 border-b border-slate-100 pb-2">เริ่มมิเตอร์ห้องใหม่</h3>
                <p className="text-sm text-slate-500">
                  เลขมิเตอร์เหล่านี้จะถูกบันทึกเป็นค่าตั้งต้น (Baseline) สำหรับคำนวณบิลตอนสิ้นเดือน
                </p>
                <div className="grid gap-4 md:grid-cols-2">
                  <Input
                    label="ไฟฟ้า ณ วันย้ายเข้า"
                    type="number"
                    value={form.new_curr_electricity}
                    onChange={(e) => setForm({ ...form, new_curr_electricity: toNumber(e.target.value) })}
                    className="text-base"
                  />
                  <Input
                    label="น้ำประปา ณ วันย้ายเข้า"
                    type="number"
                    value={form.new_curr_water}
                    onChange={(e) => setForm({ ...form, new_curr_water: toNumber(e.target.value) })}
                    className="text-base"
                  />
                </div>
              </div>
            )}

            {step === 4 && (
              <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300">
                <h3 className="text-lg font-bold text-slate-800 border-b border-slate-100 pb-2">สรุปรายการย้ายห้องกลางเดือน</h3>
                
                <div className="rounded-2xl border border-slate-200 overflow-hidden text-sm shadow-sm bg-white">
                  <div className="p-4 bg-slate-50 border-b border-slate-200">
                    <p className="font-semibold text-slate-800 text-base">การคำนวณ Pro-rate (ดึงไปออกบิลสิ้นเดือน)</p>
                  </div>
                  
                  <div className="grid grid-cols-[1fr_auto] p-4 border-b border-slate-100 hover:bg-slate-50/50">
                    <div>
                      <p className="font-medium text-slate-800">ค่าเช่าห้องเดิม</p>
                      <p className="text-xs text-slate-500">
                        {transferProration.oldRoomDays}/{transferProration.daysInMonth} วัน
                        {transferProration.billingStartDay > 1 ? ` เริ่มนับจากเข้าพักวันที่ ${transferProration.billingStartDay}` : ""}
                      </p>
                    </div>
                    <span className="font-semibold">฿{formatMoney(transferProration.oldRentAmount)}</span>
                  </div>

                  <div className="grid grid-cols-[1fr_auto] p-4 border-b border-slate-100 hover:bg-slate-50/50">
                    <div>
                      <p className="font-medium text-slate-800">ค่าเช่าห้องใหม่</p>
                      <p className="text-xs text-slate-500">
                        {transferProration.newRoomDays}/{transferProration.daysInMonth} วัน
                      </p>
                    </div>
                    <span className="font-semibold">฿{formatMoney(transferProration.newRentAmount)}</span>
                  </div>

                  <div className="grid grid-cols-[1fr_auto] p-4 border-b border-slate-100 hover:bg-slate-50/50">
                    <div>
                      <p className="font-medium text-slate-800">ค่าน้ำไฟห้องเดิม</p>
                      <p className="text-xs text-slate-500">
                        ไฟ {transferOldElectricUsage} หน่วย, น้ำ {transferOldWaterUsage} หน่วย
                      </p>
                    </div>
                    <span className="font-semibold">฿{formatMoney(transferOldUtility)}</span>
                  </div>

                  <div className="grid grid-cols-[1fr_auto] p-4 bg-blue-50/50 text-blue-900 border-t-2 border-blue-100">
                    <p className="font-bold">รวมประมาณการย้ายห้องกลางเดือน</p>
                    <span className="font-black text-lg">฿{formatMoney(transferGrandTotal)}</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── Footer Navigation ── */}
          <div className="mt-8 flex items-center justify-between border-t border-slate-100 pt-5">
            <button
              type="button"
              onClick={() => setStep(step - 1)}
              disabled={step === 1 || isSaving}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" /> ย้อนกลับ
            </button>
            
            {step < STEPS.length ? (
              <button
                type="button"
                onClick={() => {
                  if (step === 1 && !form.new_room_id) {
                    toast.error("กรุณาเลือกห้องใหม่");
                    return;
                  }
                  setStep(step + 1);
                }}
                disabled={isSaving}
                className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
              >
                ถัดไป <ChevronRight className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleConfirm}
                disabled={isSaving}
                className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-blue-700 disabled:opacity-50"
              >
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {isSaving ? "กำลังบันทึก..." : "ยืนยันการย้ายห้อง"}
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
