import {
  Building,
  FileText,
  LayoutDashboard,
  ReceiptText,
  Settings,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import { AppLocale, t } from "@/lib/i18n";

const adminNavKeys = [
  { href: "/", labelKey: "nav_dashboard", icon: LayoutDashboard },
  { href: "/rooms", labelKey: "nav_rooms", icon: Building },
  { href: "/tenants", labelKey: "nav_tenants", icon: Users },
  { href: "/meters", labelKey: "nav_meters", icon: SlidersHorizontal },
  { href: "/invoices", labelKey: "nav_invoices", icon: FileText },
  { href: "/reports", labelKey: null, label: "รายงาน", icon: ReceiptText },
  { href: "/settings", labelKey: "nav_settings", icon: Settings },
] as const;

export const getAdminNav = (locale: AppLocale) =>
  adminNavKeys.map((item) => ({
    ...item,
    label: item.labelKey ? t(locale, item.labelKey) : item.label,
  }));

export const adminNav = getAdminNav("en");
