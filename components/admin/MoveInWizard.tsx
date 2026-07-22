import React, { useState } from "react";
import { Input } from "@/components/ui/Input";
import { buttonClasses } from "@/components/ui/Button";
import { Loader2, Upload, FileText, Settings, CreditCard, CheckCircle2, ChevronRight, ChevronLeft, Save } from "lucide-react";
import { formatMoney, toNumber } from "@/lib/format";

type MoveInWizardProps = {
  form: {
    move_in_date: string;
    lease_months: number;
    initial_electricity_reading: number;
    initial_water_reading: number;
    advance_rent_amount: number;
    security_deposit_amount: number;
  };
  setForm: (updater: (prev: any) => any) => void;
  canEditTenant: boolean;
  isUploadingDepositSlip: boolean;
  depositSlipUrls: string[];
  uploadDepositSlip: (file: File | undefined) => Promise<void>;
  removeDepositSlip: (url: string) => void;
  leaseEnd: string;
  leaseActive: boolean;
  isSavingTenant: boolean;
  onSave: () => void;
};

const STEPS = [
  { id: 1, label: "สัญญาเช่า", icon: FileText, desc: "วันที่และระยะเวลา" },
  { id: 2, label: "มิเตอร์เริ่มต้น", icon: Settings, desc: "ตั้งค่ามาตรวัด" },
  { id: 3, label: "การชำระเงิน", icon: CreditCard, desc: "เงินประกันและล่วงหน้า" },
  { id: 4, label: "ยืนยัน", icon: CheckCircle2, desc: "ตรวจสอบข้อมูล" },
];

export function MoveInWizard({
  form,
  setForm,
  canEditTenant,
  isUploadingDepositSlip,
  depositSlipUrls,
  uploadDepositSlip,
  removeDepositSlip,
  leaseEnd,
  leaseActive,
  isSavingTenant,
  onSave,
}: MoveInWizardProps) {
  const [step, setStep] = useState(1);

  return (
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
                {/* Connector line */}
                {index < STEPS.length - 1 && (
                  <div
                    className={`absolute left-[15px] top-8 h-[calc(100%+8px)] w-0.5 -translate-x-1/2 ${
                      isPast ? "bg-primary-600" : "bg-slate-200"
                    }`}
                  />
                )}
                <div
                  className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                    isActive
                      ? "border-primary-600 bg-primary-600 text-white shadow-sm"
                      : isPast
                        ? "border-primary-600 bg-white text-primary-600"
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
                  <span className="mt-1 text-2xs text-slate-500">{s.desc}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Step Content ── */}
      <div className="flex-1 flex flex-col justify-between">
        <fieldset disabled={!canEditTenant || isSavingTenant} className="disabled:opacity-80 disabled:cursor-not-allowed">
          {step === 1 && (
            <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300">
              <h3 className="text-lg font-bold text-slate-800 border-b border-slate-100 pb-2">ข้อมูลสัญญาเช่า</h3>
              <div className="grid gap-4 md:grid-cols-2">
                <Input
                  label="วันที่ย้ายเข้า"
                  type="date"
                  value={form.move_in_date}
                  onChange={(event) => setForm((prev) => ({ ...prev, move_in_date: event.target.value }))}
                  className="text-base"
                />
                <Input
                  label="ระยะสัญญา (เดือน)"
                  type="number"
                  value={form.lease_months}
                  onChange={(event) => setForm((prev) => ({ ...prev, lease_months: toNumber(event.target.value) }))}
                  className="text-base"
                />
                <div className="md:col-span-2 rounded-control border border-primary-100 bg-primary-50/50 p-4 text-sm text-slate-700 flex flex-col gap-1">
                  <p className="font-semibold text-primary-900">สรุปสัญญาเช่า</p>
                  <div className="flex justify-between items-center bg-white rounded-lg px-3 py-2 mt-1 border border-primary-100">
                    <span className="text-slate-500">วันสิ้นสุดสัญญา:</span>
                    <span className="font-medium">{form.move_in_date ? leaseEnd : "-"}</span>
                  </div>
                  <div className="flex justify-between items-center bg-white rounded-lg px-3 py-2 border border-primary-100">
                    <span className="text-slate-500">สถานะสัญญา:</span>
                    <span className={`font-bold ${leaseActive ? "text-success-600" : "text-danger-600"}`}>
                      {leaseActive ? "ยังมีผล (Active)" : "หมดอายุ (Expired)"}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300">
              <h3 className="text-lg font-bold text-slate-800 border-b border-slate-100 pb-2">ตั้งค่ามิเตอร์เริ่มต้น (Baseline)</h3>
              <p className="text-sm text-slate-500">
                เลขมิเตอร์เหล่านี้จะถูกใช้เป็นจุดเริ่มต้นในการคำนวณการใช้งานในรอบบิลแรกของผู้เช่า
              </p>
              <div className="grid gap-4 md:grid-cols-2">
                <Input
                  label="เลขมิเตอร์ไฟเริ่มต้น"
                  type="number"
                  value={form.initial_electricity_reading}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, initial_electricity_reading: toNumber(event.target.value) }))
                  }
                  className="text-base"
                />
                <Input
                  label="เลขมิเตอร์น้ำเริ่มต้น"
                  type="number"
                  value={form.initial_water_reading}
                  onChange={(event) => setForm((prev) => ({ ...prev, initial_water_reading: toNumber(event.target.value) }))}
                  className="text-base"
                />
              </div>
              <div className="rounded-control border border-warning-200 bg-warning-50 p-3 flex gap-2 items-start text-sm text-warning-800">
                <Settings className="w-5 h-5 shrink-0 text-warning-600 mt-0.5" />
                <p>
                  <strong>คำแนะนำ:</strong> ตรวจสอบเลขมิเตอร์ให้ตรงกับวันย้ายเข้าจริง เพื่อป้องกันการคำนวณบิลผิดพลาดในเดือนถัดไป
                </p>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300">
              <h3 className="text-lg font-bold text-slate-800 border-b border-slate-100 pb-2">การชำระเงินแรกเข้า</h3>
              <div className="grid gap-4 md:grid-cols-2">
                <Input
                  label="ค่าเช่าล่วงหน้า (บาท)"
                  type="number"
                  value={form.advance_rent_amount}
                  onChange={(event) => setForm((prev) => ({ ...prev, advance_rent_amount: toNumber(event.target.value) }))}
                  className="text-base"
                />
                <Input
                  label="เงินประกัน (บาท)"
                  type="number"
                  value={form.security_deposit_amount}
                  onChange={(event) => setForm((prev) => ({ ...prev, security_deposit_amount: toNumber(event.target.value) }))}
                  className="text-base"
                />
              </div>
              
              <div className="rounded-control border border-slate-200 p-4 bg-slate-50">
                <p className="text-sm font-semibold text-slate-700 mb-3">สลิปเงินมัดจำ / ชำระแรกเข้า</p>
                <div className="flex flex-col gap-3">
                  <label
                    className={`inline-flex items-center justify-center gap-2 rounded-control border-2 border-dashed px-4 py-6 text-sm transition-colors ${
                      canEditTenant
                        ? "cursor-pointer border-primary-200 hover:border-primary-400 hover:bg-primary-50/50 text-primary-700 bg-white"
                        : "cursor-not-allowed border-slate-200 text-slate-400 bg-slate-50"
                    }`}
                  >
                    {isUploadingDepositSlip ? (
                      <Loader2 size={20} className="animate-spin text-primary-600" />
                    ) : (
                      <Upload size={20} className="text-primary-500" />
                    )}
                    <span className="font-medium">คลิกเพื่ออัปโหลดสลิป</span>
                    <input
                      type="file"
                      accept="image/*"
                      disabled={!canEditTenant || isUploadingDepositSlip}
                      className="hidden"
                      onChange={(e) => void uploadDepositSlip(e.target.files?.[0])}
                    />
                  </label>
                  
                  {depositSlipUrls.length > 0 && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-2">
                      {depositSlipUrls.map((url, index) => (
                        <div key={url} className="group relative rounded-lg border border-slate-200 bg-white p-2 flex items-center justify-between">
                          <a href={url} target="_blank" rel="noreferrer" className="text-sm text-primary-600 hover:underline truncate mr-2" title={url}>
                            📄 สลิปที่ {index + 1}
                          </a>
                          <button
                            type="button"
                            onClick={() => removeDepositSlip(url)}
                            className="shrink-0 rounded p-1 text-slate-400 hover:bg-danger-50 hover:text-danger-600 transition-colors"
                            title="ลบสลิป"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300">
              <h3 className="text-lg font-bold text-slate-800 border-b border-slate-100 pb-2">ยืนยันข้อมูลย้ายเข้า</h3>
              <div className="rounded-card border border-primary-100 bg-primary-50/30 overflow-hidden text-sm">
                <div className="grid grid-cols-2 p-3 border-b border-slate-100">
                  <span className="text-slate-500">วันที่ย้ายเข้า:</span>
                  <span className="font-medium text-slate-900">{form.move_in_date || "-"}</span>
                </div>
                <div className="grid grid-cols-2 p-3 border-b border-slate-100">
                  <span className="text-slate-500">ระยะเวลาสัญญา:</span>
                  <span className="font-medium text-slate-900">{form.lease_months ? `${form.lease_months} เดือน` : "-"}</span>
                </div>
                <div className="grid grid-cols-2 p-3 border-b border-slate-100">
                  <span className="text-slate-500">วันสิ้นสุดสัญญา:</span>
                  <span className={`font-medium ${leaseActive ? "text-success-600" : "text-danger-600"}`}>
                    {form.move_in_date ? leaseEnd : "-"}
                  </span>
                </div>
                <div className="grid grid-cols-2 p-3 bg-white">
                  <span className="text-slate-500">มิเตอร์เริ่มต้น:</span>
                  <span className="font-medium text-slate-900">
                    ไฟ {form.initial_electricity_reading} / น้ำ {form.initial_water_reading}
                  </span>
                </div>
                <div className="grid grid-cols-2 p-3 border-t border-slate-100 bg-white">
                  <span className="text-slate-500">ชำระแรกเข้า:</span>
                  <span className="font-medium text-slate-900">
                    ล่วงหน้า ฿{formatMoney(form.advance_rent_amount)}<br/>
                    ประกัน ฿{formatMoney(form.security_deposit_amount)}
                  </span>
                </div>
              </div>
            </div>
          )}
        </fieldset>

        {/* ── Footer Navigation ── */}
        <div className="mt-8 flex items-center justify-between border-t border-slate-100 pt-5">
          <button
            type="button"
            onClick={() => setStep(step - 1)}
            disabled={step === 1 || !canEditTenant || isSavingTenant}
            className={buttonClasses({ variant: "secondary" })}
          >
            <ChevronLeft className="h-4 w-4" /> ย้อนกลับ
          </button>
          
          {step < STEPS.length ? (
            <button
              type="button"
              onClick={() => setStep(step + 1)}
              disabled={!canEditTenant || isSavingTenant}
              className={buttonClasses({ variant: "primary" })}
            >
              ถัดไป <ChevronRight className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSave}
              disabled={!canEditTenant || isSavingTenant}
              className={buttonClasses({ variant: "primary" })}
            >
              {isSavingTenant ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {isSavingTenant ? "กำลังบันทึก..." : "บันทึกข้อมูลผู้เช่า"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Ensure Trash2 is imported
import { Trash2 } from "lucide-react";
