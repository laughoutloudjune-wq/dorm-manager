import { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";

/**
 * Table shell. Wraps a table in a floating surface with its own horizontal
 * scroll container, so wide admin tables scroll inside the card instead of
 * pushing the page sideways.
 */

export function TableCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-card border border-slate-200/70 bg-white shadow-float ${className}`}
    >
      <div className="scrollbar-slim overflow-x-auto">{children}</div>
    </div>
  );
}

export function Table({ className = "", ...props }: HTMLAttributes<HTMLTableElement>) {
  return <table className={`w-full min-w-full text-left text-sm ${className}`} {...props} />;
}

export function THead({ className = "", ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={`bg-slate-50/70 ${className}`} {...props} />;
}

export function TBody({ className = "", ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={`divide-y divide-slate-100 ${className}`} {...props} />;
}

export function TR({ className = "", ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={`transition-colors hover:bg-slate-50/70 ${className}`} {...props} />
  );
}

export function TH({ className = "", ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={`whitespace-nowrap border-b border-slate-200/70 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 ${className}`}
      {...props}
    />
  );
}

export function TD({ className = "", ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={`px-4 py-3 align-middle text-slate-700 ${className}`} {...props} />;
}
