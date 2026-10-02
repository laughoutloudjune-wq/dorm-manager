import {
  Building,
  FileText,
  Gift,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Scale,
  ReceiptText,
  Settings,
  SlidersHorizontal,
  Timer,
  Users,
  Wallet,
} from "lucide-react";
import { AppLocale, t } from "@/lib/i18n";
import type { PermissionKey } from "@/lib/permissions";

type NavDef = {
  href: string;
  labelKey: Parameters<typeof t>[1] | null;
  label?: string;
  icon: typeof Users;
  /** Hidden from the sidebar when the user lacks it. Display only; the API still enforces. */
  permission?: PermissionKey;
};

const adminNavKeys: readonly NavDef[] = [
  { href: "/", labelKey: "nav_dashboard", icon: LayoutDashboard },
  { href: "/rooms", labelKey: "nav_rooms", icon: Building, permission: "room.view" },
  { href: "/tenants", labelKey: "nav_tenants", icon: Users, permission: "tenant.view" },
  { href: "/move-outs", labelKey: "nav_move_outs", icon: LogOut },
  { href: "/meters", labelKey: "nav_meters", icon: SlidersHorizontal },
  { href: "/meter-staff", labelKey: null, label: "พนักงานมิเตอร์ LINE", icon: Users },
  { href: "/invoices", labelKey: "nav_invoices", icon: FileText },
  { href: "/reports", labelKey: null, label: "รายงาน", icon: ReceiptText },
  { href: "/action-queue", labelKey: null, label: "คิวงานที่ต้องจัดการ", icon: ListChecks, permission: "action_queue.view" },
  { href: "/late-fees", labelKey: null, label: "ค่าปรับล่าช้า", icon: Timer, permission: "late_fee.view" },
  { href: "/reconciliation", labelKey: null, label: "ตรวจสอบยอดเงิน", icon: Scale, permission: "reconciliation.view" },
  { href: "/credits-refunds", labelKey: null, label: "เครดิตและการคืนเงิน", icon: Wallet, permission: "credits.view" },
  { href: "/rewards", labelKey: null, label: "คะแนนสะสม", icon: Gift, permission: "rewards.view" },
  { href: "/settings", labelKey: "nav_settings", icon: Settings },
];

export const getAdminNav = (locale: AppLocale) =>
  adminNavKeys.map((item) => ({
    ...item,
    label: (item.labelKey ? t(locale, item.labelKey) : item.label) as string,
  }));

/**
 * Drop nav items the user lacks permission for. While permissions are still
 * loading everything is shown (fail open, display only) so the rail does not
 * flash items away; the API remains the real gate. The same holds when the
 * permission fetch failed (`failed`): the viewer fallback is a guess, so show
 * everything rather than hide the nav from a legitimate admin.
 */
export function filterNavByPermission<T extends { permission?: PermissionKey }>(
  items: readonly T[],
  can: (permission: PermissionKey) => boolean,
  loading: boolean,
  failed = false
): T[] {
  if (loading || failed) return [...items];
  return items.filter((item) => !item.permission || can(item.permission));
}

export const adminNav = getAdminNav("en");
