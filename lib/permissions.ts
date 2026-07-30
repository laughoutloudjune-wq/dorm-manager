export const PERMISSION_KEYS = [
  "invoice.create",
  "invoice.edit",
  "invoice.delete",
  "invoice.status.update",
  "invoice.payment.record",
  "tenant.view",
  "tenant.edit",
  "tenant.line.manage",
  "room.view",
  "room.edit",
  "meter.edit",
  "settings.general",
  "settings.utilities",
  "settings.invoice_config",
  "settings.payment_methods",
  "settings.rooms",
  "settings.permissions",
  "rewards.view",
  "rewards.manage",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export type RoleKey = "owner" | "admin" | "staff" | "viewer";
export type RolePermissionMap = Record<RoleKey, Record<PermissionKey, boolean>>;

export const ROLE_LABELS: Record<RoleKey, string> = {
  owner: "Owner",
  admin: "Admin",
  staff: "Staff",
  viewer: "Viewer",
};

export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  "invoice.create": "Create invoice",
  "invoice.edit": "Edit invoice details",
  "invoice.delete": "Delete invoice",
  "invoice.status.update": "Change invoice status",
  "invoice.payment.record": "Record payment / upload slip",
  "tenant.view": "View tenants",
  "tenant.edit": "Edit tenant information",
  "tenant.line.manage": "Manage tenant LINE link",
  "room.view": "View rooms",
  "room.edit": "Edit rooms/buildings",
  "meter.edit": "Edit meter readings",
  "settings.general": "Edit general settings",
  "settings.utilities": "Edit utility settings",
  "settings.invoice_config": "Edit invoice config",
  "settings.payment_methods": "Edit payment methods",
  "settings.rooms": "Edit rooms settings",
  "settings.permissions": "Edit permissions",
  "rewards.view": "View tenant rewards/points",
  "rewards.manage": "Manage rewards config, approvals & adjustments",
};

export const defaultRolePermissions = (): RolePermissionMap => {
  const allTrue = Object.fromEntries(PERMISSION_KEYS.map((key) => [key, true])) as Record<
    PermissionKey,
    boolean
  >;
  const allFalse = Object.fromEntries(PERMISSION_KEYS.map((key) => [key, false])) as Record<
    PermissionKey,
    boolean
  >;

  const admin = { ...allTrue, "settings.permissions": false };
  const staff = {
    ...allFalse,
    "invoice.create": true,
    "invoice.edit": true,
    "invoice.status.update": true,
    "invoice.payment.record": true,
    "tenant.view": true,
    "room.view": true,
    "meter.edit": true,
    "rewards.view": true,
  };
  const viewer = {
    ...allFalse,
    "invoice.status.update": false,
    "tenant.view": true,
    "room.view": true,
  };

  return {
    owner: allTrue,
    admin,
    staff,
    viewer,
  };
};

export const normalizeRolePermissions = (raw: any): RolePermissionMap => {
  const base = defaultRolePermissions();
  if (!raw || typeof raw !== "object") return base;

  const roles: RoleKey[] = ["owner", "admin", "staff", "viewer"];
  for (const role of roles) {
    const src = raw[role];
    if (!src || typeof src !== "object") continue;
    for (const key of PERMISSION_KEYS) {
      if (typeof src[key] === "boolean") {
        base[role][key] = src[key];
      }
    }
  }
  return base;
};

