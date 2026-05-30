import { RoomRow, TenantRow, MoveOutFeeLine } from "@/types";
import { roundTo2, toNumber } from "./format";

export const createMoveOutFeeLine = (): MoveOutFeeLine => ({
  id: crypto.randomUUID(),
  label: "",
  amount: 0,
});

export const parseDepositSlipUrls = (value: string | null | undefined): string[] => {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.filter((item) => typeof item === "string");
    } catch {
      return [trimmed];
    }
  }
  return [trimmed];
};

export const serializeDepositSlipUrls = (urls: string[]) => {
  if (urls.length === 0) return null;
  if (urls.length === 1) return urls[0];
  return JSON.stringify(urls);
};

export const roomNumberCompare = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

export const roomLabel = (room: RoomRow) => {
  const building = Array.isArray(room.buildings)
    ? room.buildings[0]?.name
    : room.buildings?.name;
  return `${room.room_number}${building ? ` (${building})` : ""}`;
};

export const tenantRoomNumber = (tenant: TenantRow, roomsById: Map<string, RoomRow>) => {
  const roomRel = Array.isArray(tenant.rooms) ? tenant.rooms[0] : tenant.rooms;
  return roomRel?.room_number ?? roomsById.get(tenant.room_id)?.room_number ?? "-";
};

export const tenantRoomPrice = (tenant: TenantRow, roomsById: Map<string, RoomRow>) => {
  const roomRel = Array.isArray(tenant.rooms) ? tenant.rooms[0] : tenant.rooms;
  return toNumber(roomRel?.price_month ?? roomsById.get(tenant.room_id)?.price_month ?? 0);
};

export const tenantBuildingName = (tenant: TenantRow, roomsById: Map<string, RoomRow>) => {
  const roomRel = Array.isArray(tenant.rooms) ? tenant.rooms[0] : tenant.rooms;
  if (roomRel?.buildings && Array.isArray(roomRel.buildings) && roomRel.buildings.length > 0) {
    return roomRel.buildings[0]?.name ?? "ไม่ระบุอาคาร";
  }
  const room = roomsById.get(tenant.room_id);
  if (!room?.buildings) return "ไม่ระบุอาคาร";
  if (Array.isArray(room.buildings)) return room.buildings[0]?.name ?? "ไม่ระบุอาคาร";
  return room.buildings.name ?? "ไม่ระบุอาคาร";
};

export const leaseEndDateText = (moveInDate: string, leaseMonths: number) => {
  const start = new Date(moveInDate);
  const end = new Date(start);
  end.setMonth(end.getMonth() + leaseMonths);
  return end.toISOString().slice(0, 10);
};

export const calculateTransferRentProration = (
  transferDate: string,
  moveInDate: string | null | undefined,
  oldRoomRate: number,
  newRoomRate: number
) => {
  if (!transferDate) {
    return {
      billingStartDay: 1,
      transferDay: 1,
      daysInMonth: 30,
      oldRoomDays: 0,
      newRoomDays: 30,
      oldRentAmount: 0,
      newRentAmount: newRoomRate,
    };
  }

  const transferDateObj = new Date(transferDate);
  const transferYear = transferDateObj.getFullYear();
  const transferMonth = transferDateObj.getMonth();
  const periodStart = new Date(transferYear, transferMonth, 1);
  const periodEnd = new Date(transferYear, transferMonth + 1, 0);
  const daysInMonth = periodEnd.getDate();
  const billingStart = moveInDate ? new Date(moveInDate) : periodStart;
  const effectiveBillingStart = billingStart > periodStart ? billingStart : periodStart;
  const effectiveTransferDate = transferDateObj > effectiveBillingStart ? transferDateObj : effectiveBillingStart;
  const oldRoomDays =
    effectiveTransferDate > effectiveBillingStart
      ? Math.floor(
          (new Date(
            effectiveTransferDate.getFullYear(),
            effectiveTransferDate.getMonth(),
            effectiveTransferDate.getDate() - 1
          ).getTime() -
            effectiveBillingStart.getTime()) /
            86400000
        ) + 1
      : 0;
  const newRoomDays =
    periodEnd >= effectiveTransferDate
      ? Math.floor((periodEnd.getTime() - effectiveTransferDate.getTime()) / 86400000) + 1
      : 0;
  const dailyOldRate = oldRoomRate / 30;
  const dailyNewRate = newRoomRate / 30;

  return {
    billingStartDay: effectiveBillingStart.getDate(),
    transferDay: effectiveTransferDate.getDate(),
    daysInMonth,
    oldRoomDays,
    newRoomDays,
    oldRentAmount: roundTo2(dailyOldRate * oldRoomDays),
    newRentAmount: roundTo2(dailyNewRate * newRoomDays),
  };
};

export const tenantStatusLabel = (status: string | null | undefined) => {
  if (status === "active") return "ใช้งานอยู่";
  if (status === "inactive" || status === "moved_out") return "ย้ายออกแล้ว";
  return status ?? "-";
};

export const sanitizeStorageFileName = (fileName: string) => {
  const extensionIndex = fileName.lastIndexOf(".");
  const rawBase = extensionIndex >= 0 ? fileName.slice(0, extensionIndex) : fileName;
  const rawExtension = extensionIndex >= 0 ? fileName.slice(extensionIndex).toLowerCase() : "";
  const safeBase = rawBase
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  const safeExtension = rawExtension.replace(/[^.a-z0-9]/g, "");
  return `${safeBase || "upload"}${safeExtension}`;
};

export const tenantPaymentMethodLabel = (tenant: TenantRow) => {
  const method = tenant.custom_payment_method;
  if (!method) return "-";
  if (typeof method === "string") return method;
  return method.label ?? method.type ?? "-";
};

export const findExistingActiveTenantInRoom = (
  tenants: TenantRow[],
  roomId: string,
  currentTenantId?: string | null
) =>
  tenants.find(
    (tenant) =>
      tenant.room_id === roomId &&
      tenant.status === "active" &&
      tenant.id !== (currentTenantId ?? "")
  ) ?? null;
