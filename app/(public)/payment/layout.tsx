import type { ReactNode } from "react";

export default function PaymentLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen text-slate-900">
      {children}
    </div>
  );
}
