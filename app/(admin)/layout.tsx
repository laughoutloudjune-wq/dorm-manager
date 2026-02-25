import type { Metadata } from "next";
import type { ReactNode } from "react";
import AdminShell from "@/components/AdminShell";

export const metadata: Metadata = {
  title: "Apartment Flow Admin",
  description: "Apartment Flow admin console.",
};

export default function AdminLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return <AdminShell>{children}</AdminShell>;
}
