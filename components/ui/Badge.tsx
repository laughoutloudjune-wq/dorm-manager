import { HTMLAttributes } from "react";

type Variant = "default" | "success" | "warning" | "danger" | "info";

const variantStyles: Record<Variant, string> = {
  default: "bg-slate-100 text-slate-700",
  success: "bg-green-100 text-green-700",
  warning: "bg-yellow-100 text-yellow-800",
  danger: "bg-red-100 text-red-700",
  info: "bg-blue-100 text-blue-700",
};

export function Badge({
  className = "",
  variant = "default",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: Variant }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${variantStyles[variant]} ${className}`}
      {...props}
    />
  );
}
