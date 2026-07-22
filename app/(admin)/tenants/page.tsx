"use client";

import { useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Select } from "@/components/ui/Input";
import { EmptyState, Notice, PageHeader, Skeleton } from "@/components/ui/Page";
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
  const [statusFilter, setStatusFilter] = useState("active");
  
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
      if (statusFilter === "active" && tenant.status !== "active") return false;
      if (statusFilter === "moved_out" && tenant.status !== "moved_out") return false;

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
  }, [tenants, roomsById, buildingFilter, search, statusFilter, canViewTenants]);

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
      <PageHeader
        description="ข้อมูลผู้เช่าทั้งหมด แยกตามอาคาร"
        actions={
          <Button
            onClick={() => void openModal()}
            disabled={!canEditTenant}
            title={!canEditTenant ? "ไม่มีสิทธิ์เพิ่ม/แก้ไขข้อมูลผู้เช่า" : undefined}
            icon={<Plus size={16} />}
          >
            เพิ่มผู้เช่า
          </Button>
        }
      />

      <Card className="p-3">
        <div className="flex w-full flex-col gap-2.5 md:flex-row">
          <div className="relative w-full md:max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={17} />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="ค้นหาชื่อผู้เช่าหรือเลขห้อง"
              className="pl-10"
            />
          </div>
          {buildingOptions.length > 1 && (
            <Select
              value={buildingFilter}
              onChange={(event) => setBuildingFilter(event.target.value)}
              className="md:w-56"
            >
              <option value="all">ทุกอาคาร</option>
              {buildingOptions.map((building) => (
                <option key={building} value={building}>
                  {building}
                </option>
              ))}
            </Select>
          )}
          <Select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            className="md:w-48"
          >
            <option value="all">สถานะทั้งหมด</option>
            <option value="active">กำลังพักอาศัย</option>
            <option value="moved_out">ย้ายออกแล้ว</option>
          </Select>
        </div>
      </Card>

      {!canViewTenants && <Notice tone="danger" title="บัญชีนี้ไม่มีสิทธิ์ดูข้อมูลผู้เช่า" />}

      {isPageLoading ? (
        <div className="space-y-6">
          <Skeleton className="h-6 w-32" />
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {[...Array(8)].map((_, i) => (
              <Skeleton key={i} className="h-52" />
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
                    <Card key={tenant.id} className="flex flex-col p-4 hover-float">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">ห้อง</p>
                          <h2 className="mt-1 text-base font-semibold text-slate-900">
                            {tenantRoomNumber(tenant, roomsById)}
                          </h2>
                          <p className="mt-1 truncate text-sm text-slate-600">{tenant.full_name}</p>
                        </div>
                        <Badge variant={tenant.status === "active" ? "success" : "warning"} dot>
                          {tenantStatusLabel(tenant.status)}
                        </Badge>
                      </div>

                      {(activeMoveOutRequestByTenantId.has(String(tenant.id)) ||
                        tenant.forfeit_security_deposit) && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {activeMoveOutRequestByTenantId.has(String(tenant.id)) && (
                            <Badge variant="warning" size="sm">รอจัดการย้ายออก</Badge>
                          )}
                          {tenant.forfeit_security_deposit ? (
                            <Badge variant="danger" size="sm">ไม่คืนเงินประกัน</Badge>
                          ) : null}
                        </div>
                      )}

                      <div className="mt-3 space-y-1.5 text-sm text-slate-600">
                        <div className="flex items-center justify-between rounded-control bg-slate-50 px-3 py-2">
                          <span>เบอร์โทร</span>
                          <span className="font-medium text-slate-800">{tenant.phone_number ?? "-"}</span>
                        </div>
                        <div className="flex items-center justify-between rounded-control bg-slate-50 px-3 py-2">
                          <span>LINE</span>
                          <span
                            className={`font-medium ${tenant.line_user_id ? "text-success-700" : "text-slate-500"}`}
                          >
                            {tenant.line_user_id ? "เชื่อมแล้ว" : "ยังไม่เชื่อม"}
                          </span>
                        </div>
                      </div>

                      <div className="mt-4 flex flex-wrap gap-2">
                        {activeMoveOutRequestByTenantId.has(String(tenant.id)) && (
                          <Button
                            size="sm"
                            variant="subtle"
                            disabled={!canEditTenant}
                            onClick={() => openModal(tenant, "move_out")}
                            className="border-warning-200 bg-warning-50 text-warning-800 hover:border-warning-300 hover:bg-warning-100"
                          >
                            ดูคำขอย้ายออก
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!canEditTenant}
                          title={!canEditTenant ? "ไม่มีสิทธิ์แก้ไขข้อมูลผู้เช่า" : undefined}
                          onClick={() => openModal(tenant)}
                        >
                          แก้ไขข้อมูล
                        </Button>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            ))}

          {!isPageLoading && filtered.length === 0 && canViewTenants && (
            <Card>
              <EmptyState
                icon={<Search className="h-5 w-5" />}
                title="ไม่พบข้อมูลผู้เช่าตามคำค้นหา"
                description="ลองเปลี่ยนคำค้นหา อาคาร หรือสถานะที่เลือกไว้"
              />
            </Card>
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
