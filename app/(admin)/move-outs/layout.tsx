import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "ย้ายออก",
};

export default function MoveOutsLayout({ children }: { children: ReactNode }) {
  return children;
}
