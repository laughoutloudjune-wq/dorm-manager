"use client";

import { createContext, useContext, ReactNode } from "react";
import { useInvoicesState } from "@/lib/hooks/use-invoices-state";

type InvoiceState = ReturnType<typeof useInvoicesState>;

const InvoiceContext = createContext<InvoiceState | null>(null);

export function InvoiceProvider({ children, state }: { children: ReactNode; state: InvoiceState }) {
  return <InvoiceContext.Provider value={state}>{children}</InvoiceContext.Provider>;
}

export function useInvoiceContext() {
  const context = useContext(InvoiceContext);
  if (!context) {
    throw new Error("useInvoiceContext must be used within an InvoiceProvider");
  }
  return context;
}
