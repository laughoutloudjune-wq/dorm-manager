import { HTMLAttributes } from "react";

type Variant = "default" | "success" | "warning" | "danger" | "info";

const variantStyles: Record<Variant, string> = {
  default: "border border-slate-200/80 bg-slate-50/90 text-slate-700",
  success: "border border-emerald-200/60 bg-emerald-50/90 text-emerald-800",
  warning: "border border-amber-200/60 bg-amber-50/90 text-amber-900",
  danger: "border border-red-200/60 bg-red-50/90 text-red-800",
  info: "border border-blue-200/60 bg-blue-50/90 text-blue-800",
};

export function Badge({
  className = "",
  variant = "default",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: Variant }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-semibold leading-tight shadow-sm ${variantStyles[variant]} ${className}`}
      {...props}
    />
  );
}
