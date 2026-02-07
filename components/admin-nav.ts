import {
  Building,
  FileText,
  LayoutDashboard,
  Settings,
  SlidersHorizontal,
  Users,
} from "lucide-react";

export const adminNav = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/rooms", label: "Rooms", icon: Building },
  { href: "/tenants", label: "Tenants", icon: Users },
  { href: "/meters", label: "Meters", icon: SlidersHorizontal },
  { href: "/invoices", label: "Invoices", icon: FileText },
  { href: "/settings", label: "Settings", icon: Settings },
];
