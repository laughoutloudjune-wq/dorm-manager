"use client";

import { useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { TenantEditorModal } from "@/components/admin/tenant-editor-modal";
import { usePermissions } from "@/lib/use-permissions";
import { useTenants, useRooms, useMoveOutRequests } from "@/lib/hooks/use-data";
import { TenantRow, RoomRow, MoveOutRequestRow } from "@/types";
import { tenantStatusLabel, tenantRoomNumber } from "@/lib/tenant-utils";

export default function TenantsPage() {
  const { can } = usePermissions();
  const { data: tenants = [], mutate: mutateTenants, isLoading: isLoadingTenants } = useTenants();
  const { data: rooms = [], isLoading: isLoadingRooms } = useRooms();
  const { data: moveOutRequests = [] } = useMoveOutRequests();
  
  const [search, setSearch] = useState("");
  const [buildingFilter, setBuildingFilter] = useState("all");
  
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [activeTenant, setActiveTenant] = useState<TenantRow | null>(null);
  const [activeTab, setActiveTab] = useState<"info" | "move_in" | "move_out" | "payments">("info");

  const canViewTenants = can("tenant.view");
  const canEditTenant = can("tenant.edit");
  const isPageLoading = isLoadingTenants || isLoadingRooms;

  const openModal = (tenant?: TenantRow, initialTab: "info" | "move_in" | "move_out" | "payments" = "info") => {
    setActiveTenant(tenant ?? null);
    setActiveTab(initialTab);
    setIsModalOpen(true);
  };

  const roomsById = useMemo(() => new Map(rooms.map((r) => [String(r.id), r])), [rooms]);

  const activeMoveOutRequestByTenantId = useMemo(() => {
    const m = new Map<string, MoveOutRequestRow>();
    for (const req of moveOutRequests) {
      if (req.status === "requested") {
        m.set(String(req.tenant_id), req);
      }
    }
    return m;
  }, [moveOutRequests]);

  const filtered = useMemo(() => {
    if (!canViewTenants) return [];
    return tenants.filter((tenant) => {
      const room = roomsById.get(String(tenant.room_id));
      const building = Array.isArray(room?.buildings)
        ? room?.buildings[0]?.name
        : room?.buildings?.name;
      const passBuilding = buildingFilter === "all" || building === buildingFilter;
      const s = search.toLowerCase();
      const passSearch =
        !s ||
        (tenant.full_name ?? "").toLowerCase().includes(s) ||
        (room?.room_number ?? "").toLowerCase().includes(s);
      return passBuilding && passSearch;
    });
  }, [tenants, roomsById, buildingFilter, search, canViewTenants]);

  const groupedTenants = useMemo(() => {
    const g: Record<string, TenantRow[]> = {};
    for (const t of filtered) {
      const r = roomsById.get(String(t.room_id));
      const b = (Array.isArray(r?.buildings) ? r?.buildings[0]?.name : r?.buildings?.name) ?? "ไม่ระบุอาคาร";
      if (!g[b]) g[b] = [];
      g[b].push(t);
    }
    return g;
  }, [filtered, roomsById]);

  const buildingOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rooms) {
      const b = (Array.isArray(r.buildings) ? r.buildings[0]?.name : r.buildings?.name) ?? "ไม่ระบุอาคาร";
      set.add(b);
    }
    return Array.from(set).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
    );
  }, [rooms]);

  return (
    <div className="space-y-6 pb-20">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex w-full flex-col gap-3 md:w-auto md:flex-row">
          <div className="relative w-full md:w-80">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="ค้นหาชื่อผู้เช่าหรือเลขห้อง"
              className="w-full rounded-xl border border-slate-200 bg-white py-3 pl-10 pr-4 text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-600/40"
            />
          </div>
          {buildingOptions.length > 1 && (
            <select
              value={buildingFilter}
              onChange={(event) => setBuildingFilter(event.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-600/40 md:w-56"
            >
              <option value="all">ทุกอาคาร</option>
              {buildingOptions.map((building) => (
                <option key={building} value={building}>
                  {building}
                </option>
              ))}
            </select>
          )}
        </div>
        <button
          onClick={() => void openModal()}
          disabled={!canEditTenant}
          title={!canEditTenant ? "ไม่มีสิทธิ์เพิ่ม/แก้ไขข้อมูลผู้เช่า" : undefined}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-base font-semibold text-white shadow-lg shadow-blue-600/20 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
        >
          <Plus size={16} />
          เพิ่มผู้เช่า
        </button>
      </div>

      {!canViewTenants && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          บัญชีนี้ไม่มีสิทธิ์ดูข้อมูลผู้เช่า
        </div>
      )}

      {isPageLoading ? (
        <div className="space-y-6">
          <div className="h-6 w-32 bg-slate-200 rounded animate-pulse"></div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm animate-pulse">
                <div className="h-4 w-12 bg-slate-200 rounded mb-2"></div>
                <div className="h-6 w-20 bg-slate-200 rounded mb-4"></div>
                <div className="h-4 w-32 bg-slate-200 rounded mb-6"></div>
                <div className="h-10 w-full bg-slate-200 rounded mt-4"></div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          {Object.entries(groupedTenants)
            .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
            .map(([building, buildingTenants]) => (
              <div key={building} className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-lg font-semibold text-slate-900">{building}</h2>
                  <Badge variant="info" className="text-sm">
                    {buildingTenants.length} รายการ
                  </Badge>
                </div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {buildingTenants
                    .sort((a, b) => {
                      const rA = tenantRoomNumber(a, roomsById);
                      const rB = tenantRoomNumber(b, roomsById);
                      return rA.localeCompare(rB, undefined, { numeric: true, sensitivity: "base" });
                    })
                    .map((tenant) => (
                    <div
                      key={tenant.id}
                      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">ห้อง</p>
                          <h2 className="mt-1 text-base font-semibold text-slate-900">{tenantRoomNumber(tenant, roomsById)}</h2>
                          <p className="mt-1 text-sm text-slate-600">{tenant.full_name}</p>
                        </div>
                        <Badge variant={tenant.status === "active" ? "success" : "warning"}>
                          {tenantStatusLabel(tenant.status)}
                        </Badge>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        {activeMoveOutRequestByTenantId.has(String(tenant.id)) && (
                          <Badge variant="warning">รอจัดการย้ายออก</Badge>
                        )}
                        {tenant.forfeit_security_deposit ? <Badge variant="danger">ไม่คืนเงินประกัน</Badge> : null}
                      </div>

                      <div className="mt-3 space-y-2 text-sm text-slate-600">
                        <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
                          <span>เบอร์โทร</span>
                          <span className="font-medium text-slate-800">{tenant.phone_number ?? "-"}</span>
                        </div>
                        <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
                          <span>LINE</span>
                          <span className={`font-medium ${tenant.line_user_id ? "text-emerald-700" : "text-slate-500"}`}>
                            {tenant.line_user_id ? "เชื่อมแล้ว" : "ยังไม่เชื่อม"}
                          </span>
                        </div>
                      </div>

                      <div className="mt-4 flex flex-wrap gap-2">
                        {activeMoveOutRequestByTenantId.has(String(tenant.id)) && (
                          <button
                            type="button"
                            disabled={!canEditTenant}
                            onClick={() => openModal(tenant, "move_out")}
                            className="rounded-xl border border-orange-200 bg-orange-50 px-3 py-2 text-sm font-medium text-orange-700 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            ดูคำขอย้ายออก
                          </button>
                        )}
                        <button
                          disabled={!canEditTenant}
                          title={!canEditTenant ? "ไม่มีสิทธิ์แก้ไขข้อมูลผู้เช่า" : undefined}
                          className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:border-red-200 disabled:text-red-400"
                          onClick={() => openModal(tenant)}
                        >
                          แก้ไขข้อมูล
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}

          {!isPageLoading && filtered.length === 0 && canViewTenants && (
            <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center text-slate-500">
              ไม่พบข้อมูลผู้เช่าตามคำค้นหา
            </div>
          )}
        </>
      )}

      <TenantEditorModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        tenantId={activeTenant?.id ?? null}
        initialTab={activeTab}
        onRefresh={() => mutateTenants()}
      />
    </div>
  );
}
