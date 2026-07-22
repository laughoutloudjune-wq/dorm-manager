import { HTMLAttributes, ReactNode } from "react";

/**
 * Status pill. Variants are named by meaning, not by color, so the same status
 * renders identically wherever it appears.
 */

type Variant =
  | "default"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "neutral"
  | "primary";

const variantStyles: Record<Variant, string> = {
  default: "border-slate-200 bg-slate-50 text-slate-700",
  neutral: "border-slate-200 bg-slate-50 text-slate-700",
  success: "border-success-200/70 bg-success-50 text-success-700",
  warning: "border-warning-200/70 bg-warning-50 text-warning-800",
  danger: "border-danger-200/70 bg-danger-50 text-danger-700",
  info: "border-primary-200/70 bg-primary-50 text-primary-700",
  primary: "border-primary-200/70 bg-primary-50 text-primary-700",
};

const dotStyles: Record<Variant, string> = {
  default: "bg-slate-400",
  neutral: "bg-slate-400",
  success: "bg-success-500",
  warning: "bg-warning-500",
  danger: "bg-danger-500",
  info: "bg-primary-500",
  primary: "bg-primary-500",
};

const sizeStyles = {
  sm: "px-2 py-0.5 text-2xs",
  md: "px-2.5 py-1 text-xs",
} as const;

export function Badge({
  className = "",
  variant = "default",
  size = "md",
  dot = false,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  variant?: Variant;
  size?: keyof typeof sizeStyles;
  /** Prefixes a status dot — helps distinguish states without relying on hue alone. */
  dot?: boolean;
  children?: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-semibold leading-tight ${sizeStyles[size]} ${variantStyles[variant]} ${className}`}
      {...props}
    >
      {dot && (
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotStyles[variant]}`} aria-hidden />
      )}
      {children}
    </span>
  );
}
