import type { ReactNode } from "react";

export default function PaymentLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_#dbeafe,_#f8fafc_60%)] text-slate-900">
      {children}
    </div>
  );
}
