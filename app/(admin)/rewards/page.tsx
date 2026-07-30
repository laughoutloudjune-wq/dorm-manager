"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { SectionCard } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { ConfirmActionModal } from "@/components/ui/ConfirmActionModal";
import { PageHeader, EmptyState, Skeleton, Notice } from "@/components/ui/Page";
import { Table, TableCard, TBody, THead, TD, TH, TR } from "@/components/ui/Table";
import { createClient } from "@/lib/supabase-client";
import { Gift, Save, Check, X, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

type RewardsConfig = {
  points_per_baht: number;
  ontime_rent_rate_pct: number;
  streak_bonus_points: number;
  streak_length: number;
  referral_bonus_points: number;
  milestone_3mo_points: number;
  milestone_1yr_points: number;
  milestone_1yr_repeats: boolean;
  max_redemption_baht: number;
  max_redemptions_per_month: number;
  point_expiry_months: number;
  program_start_date: string | null;
};

type TenantSummary = {
  id: string;
  full_name: string;
  status: string;
  room_number: string | null;
  balance: number;
};

type PendingReferral = {
  id: string;
  status: string;
  reported_at: string;
  referrer: { id: string; full_name: string } | null;
  new_tenant: { id: string; full_name: string } | null;
};

type LedgerRow = {
  id: string;
  points: number;
  reason: string;
  baht_equivalent: number;
  notes: string | null;
  created_at: string;
};

const REASON_LABELS: Record<string, string> = {
  rent_on_time: "ชำระค่าเช่าตรงเวลา",
  streak_bonus: "โบนัสชำระตรงเวลาต่อเนื่อง",
  referral_bonus: "โบนัสแนะนำเพื่อน",
  milestone_3mo: "โบนัสครบ 3 เดือน",
  milestone_1yr: "โบนัสครบ 1 ปี",
  redemption: "แลกคะแนน",
  manual_adjustment: "ปรับปรุงคะแนนโดยผู้ดูแล",
};

const formatDateThai = (value?: string | null) => (value ? new Date(value).toLocaleDateString("th-TH") : "-");

export default function RewardsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [config, setConfig] = useState<RewardsConfig | null>(null);
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [pendingReferrals, setPendingReferrals] = useState<PendingReferral[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);
  const [detailTenant, setDetailTenant] = useState<TenantSummary | null>(null);
  const [detailHistory, setDetailHistory] = useState<LedgerRow[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [adjustPoints, setAdjustPoints] = useState("");
  const [adjustNotes, setAdjustNotes] = useState("");
  const [adjusting, setAdjusting] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);
  const [redemptionToDelete, setRedemptionToDelete] = useState<LedgerRow | null>(null);
  const [deletingRedemption, setDeletingRedemption] = useState(false);

  const callAction = async (action: string, payload: Record<string, unknown> = {}) => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Session expired. Please log in again.");
    const response = await fetch("/api/admin/rewards/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...payload }),
    });
    const dataJson = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(dataJson?.error ?? "Rewards action failed.");
    return dataJson;
  };

  const loadOverview = async () => {
    setLoading(true);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Session expired. Please log in again.");
      const [overviewRes, referralsRes] = await Promise.all([
        fetch("/api/admin/rewards/actions", { headers: { Authorization: `Bearer ${token}` } }),
        callAction("list_pending_referrals"),
      ]);
      const overview = await overviewRes.json();
      if (!overviewRes.ok) throw new Error(overview?.error ?? "Failed to load rewards overview.");
      setConfig(overview.config);
      setTenants(overview.tenants ?? []);
      setPendingReferrals(referralsRes.referrals ?? []);
    } catch (error: any) {
      toast.error(error?.message ?? "Failed to load rewards overview.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateConfigField = (field: keyof RewardsConfig, value: number | boolean | string | null) => {
    setConfig((prev) => (prev ? { ...prev, [field]: value } : prev));
  };

  const saveConfig = async () => {
    if (!config) return;
    setSavingConfig(true);
    try {
      await callAction("save_config", { config });
      toast.success("บันทึกการตั้งค่าคะแนนสะสมเรียบร้อย");
    } catch (error: any) {
      toast.error(error?.message ?? "บันทึกการตั้งค่าไม่สำเร็จ");
    } finally {
      setSavingConfig(false);
    }
  };

  const openTenantDetail = async (tenant: TenantSummary) => {
    setDetailTenant(tenant);
    setDetailLoading(true);
    setAdjustPoints("");
    setAdjustNotes("");
    try {
      const result = await callAction("tenant_summary", { tenantId: tenant.id });
      setDetailHistory(result.history ?? []);
      setTenants((prev) => prev.map((t) => (t.id === tenant.id ? { ...t, balance: result.balance ?? t.balance } : t)));
    } catch (error: any) {
      toast.error(error?.message ?? "โหลดประวัติคะแนนไม่สำเร็จ");
    } finally {
      setDetailLoading(false);
    }
  };

  const submitAdjustment = async () => {
    if (!detailTenant) return;
    const points = Number(adjustPoints);
    if (!points || Number.isNaN(points)) {
      toast.error("กรุณาระบุจำนวนคะแนน (ติดลบได้)");
      return;
    }
    setAdjusting(true);
    try {
      await callAction("manual_adjust", { tenantId: detailTenant.id, points, notes: adjustNotes });
      toast.success("ปรับปรุงคะแนนเรียบร้อย");
      await openTenantDetail(detailTenant);
      await loadOverview();
    } catch (error: any) {
      toast.error(error?.message ?? "ปรับปรุงคะแนนไม่สำเร็จ");
    } finally {
      setAdjusting(false);
    }
  };

  const confirmDeleteRedemption = async () => {
    if (!redemptionToDelete || !detailTenant) return;
    setDeletingRedemption(true);
    try {
      await callAction("delete_redemption", { entryId: redemptionToDelete.id });
      toast.success("ลบรายการแลกคะแนนแล้ว คืนแต้มและสิทธิ์แลกคะแนนของเดือนนี้ให้ผู้เช่าแล้ว");
      setRedemptionToDelete(null);
      await openTenantDetail(detailTenant);
      await loadOverview();
    } catch (error: any) {
      toast.error(error?.message ?? "ลบรายการไม่สำเร็จ");
    } finally {
      setDeletingRedemption(false);
    }
  };

  const handleApproveReferral = async (referralId: string) => {
    try {
      await callAction("approve_referral", { referralId });
      toast.success("อนุมัติการแนะนำเรียบร้อย");
      await loadOverview();
    } catch (error: any) {
      toast.error(error?.message ?? "อนุมัติไม่สำเร็จ");
    }
  };

  const handleRejectReferral = async (referralId: string) => {
    try {
      await callAction("reject_referral", { referralId });
      toast.success("ปฏิเสธการแนะนำแล้ว");
      await loadOverview();
    } catch (error: any) {
      toast.error(error?.message ?? "ปฏิเสธไม่สำเร็จ");
    }
  };

  const handleSyncAll = async () => {
    setSyncingAll(true);
    try {
      const result = await callAction("sync_all");
      toast.success(
        `ซิงค์คะแนนเรียบร้อย: ตรวจสอบ ${result.tenantsChecked} คน, ได้คะแนนใหม่ ${result.entriesAwarded} รายการ, ปรับคะแนนเดิมตามค่าตั้งค่าใหม่ ${result.entriesAdjusted ?? 0} รายการ`
      );
      if (result.errors?.length) {
        toast.error(`มีข้อผิดพลาด ${result.errors.length} รายการระหว่างซิงค์`);
      }
      await loadOverview();
    } catch (error: any) {
      toast.error(error?.message ?? "ซิงค์คะแนนไม่สำเร็จ");
    } finally {
      setSyncingAll(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        description="ตั้งค่าและติดตามคะแนนสะสมของผู้เช่า"
        actions={
          <Button
            variant="secondary"
            onClick={() => void handleSyncAll()}
            loading={syncingAll}
            icon={<RefreshCw size={16} />}
          >
            ซิงค์คะแนนทั้งหมด
          </Button>
        }
      />

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-64" />
        </div>
      ) : (
        <>
          <SectionCard
            title="การตั้งค่าคะแนนสะสม"
            description="ปรับอัตราและเพดานต่างๆ ได้ตลอดเวลา"
            action={
              <Button onClick={() => void saveConfig()} loading={savingConfig} icon={<Save size={16} />}>
                บันทึก
              </Button>
            }
          >
            {config && (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Input
                  label="เริ่มนับคะแนนค่าเช่าตั้งแต่งวดที่เริ่มวันที่ (ว่าง = นับย้อนหลังทั้งหมด)"
                  type="date"
                  value={config.program_start_date ?? ""}
                  onChange={(e) => updateConfigField("program_start_date", e.target.value || null)}
                  hint="กันย้อนหลังทั้งค่าเช่าตรงเวลาและโบนัสครบ 3 เดือน/1 ปี — ถ้าครบกำหนดก่อนวันนี้จะไม่ได้คะแนนย้อนหลัง"
                />
                <Input
                  label="อัตราแลกคะแนน (แต้ม ต่อ 1 บาท)"
                  type="number"
                  value={config.points_per_baht}
                  onChange={(e) => updateConfigField("points_per_baht", Number(e.target.value))}
                />
                <Input
                  label="อัตราคะแนนชำระตรงเวลา (% ของยอดบิลรวมทั้งใบ)"
                  type="number"
                  step="0.1"
                  value={config.ontime_rent_rate_pct}
                  onChange={(e) => updateConfigField("ontime_rent_rate_pct", Number(e.target.value))}
                />
                <Input
                  label="จำนวนงวดต่อเนื่องเพื่อรับโบนัส"
                  type="number"
                  value={config.streak_length}
                  onChange={(e) => updateConfigField("streak_length", Number(e.target.value))}
                />
                <Input
                  label="โบนัสชำระตรงเวลาต่อเนื่อง (แต้ม)"
                  type="number"
                  value={config.streak_bonus_points}
                  onChange={(e) => updateConfigField("streak_bonus_points", Number(e.target.value))}
                />
                <Input
                  label="โบนัสแนะนำเพื่อน (แต้ม)"
                  type="number"
                  value={config.referral_bonus_points}
                  onChange={(e) => updateConfigField("referral_bonus_points", Number(e.target.value))}
                />
                <Input
                  label="โบนัสครบ 3 เดือน (แต้ม)"
                  type="number"
                  value={config.milestone_3mo_points}
                  onChange={(e) => updateConfigField("milestone_3mo_points", Number(e.target.value))}
                />
                <Input
                  label="โบนัสครบ 1 ปี (แต้ม)"
                  type="number"
                  value={config.milestone_1yr_points}
                  onChange={(e) => updateConfigField("milestone_1yr_points", Number(e.target.value))}
                />
                <label className="flex items-center gap-2 self-end pb-2 text-sm font-medium text-slate-700">
                  <input
                    type="checkbox"
                    checked={config.milestone_1yr_repeats}
                    onChange={(e) => updateConfigField("milestone_1yr_repeats", e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500/30"
                  />
                  ให้โบนัสทุกปีที่ครบรอบ
                </label>
                <Input
                  label="ส่วนลดสูงสุดต่อการแลก (บาท)"
                  type="number"
                  value={config.max_redemption_baht}
                  onChange={(e) => updateConfigField("max_redemption_baht", Number(e.target.value))}
                />
                <Input
                  label="จำนวนครั้งที่แลกได้ต่อเดือน"
                  type="number"
                  value={config.max_redemptions_per_month}
                  onChange={(e) => updateConfigField("max_redemptions_per_month", Number(e.target.value))}
                />
                <Input
                  label="อายุคะแนน (เดือน, 0 = ไม่หมดอายุ)"
                  type="number"
                  value={config.point_expiry_months}
                  onChange={(e) => updateConfigField("point_expiry_months", Number(e.target.value))}
                />
              </div>
            )}
          </SectionCard>

          {pendingReferrals.length > 0 && (
            <SectionCard title="คำขอแนะนำเพื่อนที่รอตรวจสอบ" description="อนุมัติก่อนคะแนนจะเข้าบัญชีผู้แนะนำ">
              <div className="space-y-2">
                {pendingReferrals.map((referral) => (
                  <div
                    key={referral.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-slate-200/70 px-4 py-3"
                  >
                    <div>
                      <p className="text-sm font-medium text-slate-900">
                        {referral.referrer?.full_name ?? "-"} แนะนำ {referral.new_tenant?.full_name ?? "-"}
                      </p>
                      <p className="text-xs text-slate-500">แจ้งเมื่อ {formatDateThai(referral.reported_at)}</p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="success"
                        size="sm"
                        icon={<Check size={14} />}
                        onClick={() => void handleApproveReferral(referral.id)}
                      >
                        อนุมัติ
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        icon={<X size={14} />}
                        onClick={() => void handleRejectReferral(referral.id)}
                      >
                        ปฏิเสธ
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>
          )}

          <SectionCard
            title="คะแนนสะสมของผู้เช่า"
            description="เรียงตามเลขห้อง — คลิกที่รายชื่อเพื่อดูประวัติและปรับปรุงคะแนน คะแนนจะคำนวณอัตโนมัติเมื่อมีการชำระเงินใหม่ ส่วนยอดที่ค้างจากก่อนเปิดใช้ฟีเจอร์นี้ให้กด “ซิงค์คะแนนทั้งหมด” ด้านบน"
          >
            {tenants.length === 0 ? (
              <EmptyState icon={<Gift size={22} />} title="ยังไม่มีผู้เช่า" />
            ) : (
              <TableCard>
                <Table>
                  <THead>
                    <TR>
                      <TH>ผู้เช่า</TH>
                      <TH>ห้อง</TH>
                      <TH>สถานะ</TH>
                      <TH className="text-right">คะแนนสะสม</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {tenants.map((tenant) => (
                      <TR key={tenant.id} className="cursor-pointer" onClick={() => void openTenantDetail(tenant)}>
                        <TD>{tenant.full_name}</TD>
                        <TD>{tenant.room_number ?? "-"}</TD>
                        <TD>
                          <Badge variant={tenant.status === "active" ? "success" : "neutral"}>{tenant.status}</Badge>
                        </TD>
                        <TD className="text-right tabular-nums font-semibold">{tenant.balance.toLocaleString("th-TH")}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableCard>
            )}
          </SectionCard>
        </>
      )}

      <Modal
        isOpen={!!detailTenant}
        onClose={() => setDetailTenant(null)}
        title={detailTenant ? `ประวัติคะแนน — ${detailTenant.full_name}` : ""}
        size="lg"
      >
        {detailLoading ? (
          <Skeleton className="h-48" />
        ) : (
          <div className="space-y-4">
            <div className="rounded-card border border-slate-200/70 bg-slate-50/60 p-4">
              <p className="text-sm font-medium text-slate-700">ปรับปรุงคะแนนด้วยตนเอง</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_2fr_auto]">
                <Input
                  type="number"
                  placeholder="จำนวนแต้ม (ติดลบได้)"
                  value={adjustPoints}
                  onChange={(e) => setAdjustPoints(e.target.value)}
                />
                <Input
                  placeholder="หมายเหตุ"
                  value={adjustNotes}
                  onChange={(e) => setAdjustNotes(e.target.value)}
                />
                <Button onClick={() => void submitAdjustment()} loading={adjusting}>
                  บันทึก
                </Button>
              </div>
            </div>

            {detailHistory.length === 0 ? (
              <Notice tone="info">ยังไม่มีประวัติคะแนน</Notice>
            ) : (
              <TableCard>
                <Table>
                  <THead>
                    <TR>
                      <TH>วันที่</TH>
                      <TH>รายการ</TH>
                      <TH>หมายเหตุ</TH>
                      <TH className="text-right">แต้ม</TH>
                      <TH className="text-right"></TH>
                    </TR>
                  </THead>
                  <TBody>
                    {detailHistory.map((row) => (
                      <TR key={row.id}>
                        <TD>{formatDateThai(row.created_at)}</TD>
                        <TD>{REASON_LABELS[row.reason] ?? row.reason}</TD>
                        <TD className="text-slate-500">{row.notes ?? "-"}</TD>
                        <TD className={`text-right tabular-nums font-semibold ${row.points >= 0 ? "text-success-700" : "text-danger-700"}`}>
                          {row.points >= 0 ? "+" : ""}
                          {row.points.toLocaleString("th-TH")}
                        </TD>
                        <TD className="text-right">
                          {row.reason === "redemption" && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setRedemptionToDelete(row)}
                              title="ลบรายการแลกคะแนน (คืนแต้มและสิทธิ์เดือนนี้)"
                            >
                              <Trash2 size={16} className="text-danger-600" />
                            </Button>
                          )}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableCard>
            )}
          </div>
        )}
      </Modal>

      <ConfirmActionModal
        isOpen={!!redemptionToDelete}
        title="ลบรายการแลกคะแนน"
        message={
          redemptionToDelete
            ? `ลบรายการแลกคะแนนนี้ (${Math.abs(redemptionToDelete.points).toLocaleString("th-TH")} แต้ม, ${formatDateThai(redemptionToDelete.created_at)})? แต้มจะถูกคืนให้ผู้เช่าและสิทธิ์แลกคะแนนของเดือนนี้จะกลับมาใช้ได้อีกครั้ง ส่วนลดที่ใช้ไปแล้วบนใบแจ้งหนี้จะไม่ถูกย้อนกลับ`
            : ""
        }
        confirmLabel="ลบรายการ"
        destructive
        loading={deletingRedemption}
        onCancel={() => setRedemptionToDelete(null)}
        onConfirm={confirmDeleteRedemption}
      />
    </div>
  );
}
