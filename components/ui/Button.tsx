import { ButtonHTMLAttributes, forwardRef, ReactNode } from "react";
import { Loader2 } from "lucide-react";

/**
 * The one button in the admin app.
 *
 * Before this existed, roughly a hundred buttons were hand-rolled inline and no
 * two agreed: `px-4 py-2 text-sm font-semibold` here, `px-5 py-2.5 text-sm
 * font-bold` there, `px-3 py-1.5 text-xs` somewhere else, with `bg-blue-600`
 * and `bg-primary-600` used interchangeably for the same action. If you need a
 * button, use this — if it can't express what you need, extend a variant here
 * rather than writing classes at the call site.
 *
 * For links that should look like buttons, use `buttonClasses()` on a
 * next/link `<Link>` instead of nesting a button inside an anchor.
 */

export type ButtonVariant =
  | "primary" // the single main action on a view
  | "secondary" // neutral action sitting next to a primary one
  | "ghost" // low-emphasis, no resting fill (toolbars, table row actions)
  | "subtle" // tinted fill, for repeated non-destructive actions
  | "danger" // destructive and irreversible
  | "success"; // confirms/settles money — used sparingly

export type ButtonSize = "sm" | "md" | "lg" | "icon";

const base =
  "inline-flex items-center justify-center gap-2 rounded-control font-semibold " +
  "transition-[background-color,border-color,box-shadow,transform,color] duration-200 ease-float " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/35 focus-visible:ring-offset-2 " +
  "focus-visible:ring-offset-white active:translate-y-px " +
  "disabled:pointer-events-none disabled:opacity-50 whitespace-nowrap";

// Filled variants carry a colored shadow at rest and lift on hover; outline and
// ghost variants stay flat, so emphasis reads as elevation rather than only hue.
const variants: Record<ButtonVariant, string> = {
  primary:
    "bg-primary-600 text-white shadow-float hover:bg-primary-700 hover:shadow-float-md",
  secondary:
    "border border-slate-200 bg-white text-slate-700 shadow-float hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900",
  ghost: "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
  subtle:
    "border border-primary-100 bg-primary-50 text-primary-700 hover:border-primary-200 hover:bg-primary-100",
  danger:
    "bg-danger-600 text-white shadow-float hover:bg-danger-700 hover:shadow-float-md",
  success:
    "bg-success-600 text-white shadow-float hover:bg-success-700 hover:shadow-float-md",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-base",
  icon: "h-10 w-10 p-0",
};

export function buttonClasses({
  variant = "primary",
  size = "md",
  fullWidth = false,
  className = "",
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
} = {}) {
  return [base, variants[variant], sizes[size], fullWidth ? "w-full" : "", className]
    .filter(Boolean)
    .join(" ");
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  /** Swaps the leading icon for a spinner and disables the button. */
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    fullWidth = false,
    loading = false,
    icon,
    iconRight,
    className = "",
    disabled,
    children,
    type = "button",
    ...props
  },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={buttonClasses({ variant, size, fullWidth, className })}
      {...props}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
      ) : (
        icon
      )}
      {children}
      {!loading && iconRight}
    </button>
  );
});
