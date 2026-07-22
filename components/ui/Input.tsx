import {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
  forwardRef,
} from "react";

/**
 * Form controls. `Input`, `Select` and `Textarea` share one `controlClasses()`
 * definition so a text field and a dropdown standing side by side are the same
 * height, radius, border and focus treatment — previously each was styled
 * inline per call site and they visibly disagreed.
 */

export function controlClasses({
  invalid = false,
  className = "",
}: { invalid?: boolean; className?: string } = {}) {
  return [
    "w-full rounded-control border bg-white px-3.5 py-2.5 text-sm text-slate-900",
    "shadow-[inset_0_1px_2px_rgba(15,23,42,0.03)] transition-[border-color,box-shadow] duration-200 ease-float",
    "placeholder:text-slate-400",
    "focus:outline-none focus:ring-2",
    invalid
      ? "border-danger-300 focus:border-danger-400 focus:ring-danger-500/20"
      : "border-slate-200 focus:border-primary-400 focus:ring-primary-500/20",
    "disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500",
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Label + control + hint/error wrapper, so field spacing is uniform. */
export function Field({
  label,
  hint,
  error,
  required,
  children,
  className = "",
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block space-y-1.5 ${className}`}>
      {label && (
        <span className="block text-sm font-medium text-slate-700">
          {label}
          {required && <span className="ml-0.5 text-danger-500">*</span>}
        </span>
      )}
      {children}
      {error ? (
        <span className="block text-xs text-danger-600">{error}</span>
      ) : hint ? (
        <span className="block text-xs text-slate-500">{hint}</span>
      ) : null}
    </label>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: ReactNode;
  error?: ReactNode;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, className = "", value, required, ...props },
  ref
) {
  const control = (
    <input
      ref={ref}
      {...props}
      required={required}
      value={value !== undefined ? (value ?? "") : undefined}
      className={controlClasses({ invalid: Boolean(error), className })}
    />
  );

  // Bare control when there's nothing to wrap — keeps grid/flex layouts from
  // gaining a stray label element.
  if (!label && !hint && !error) return control;

  return (
    <Field label={label} hint={hint} error={error} required={required}>
      {control}
    </Field>
  );
});

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
  hint?: ReactNode;
  error?: ReactNode;
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, className = "", children, required, ...props },
  ref
) {
  const control = (
    <select
      ref={ref}
      {...props}
      required={required}
      className={controlClasses({
        invalid: Boolean(error),
        // Native arrow removed and redrawn so the control matches Input's
        // height and padding rather than the OS default chrome.
        className: `appearance-none bg-[url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='%2394a3b8' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 8l4 4 4-4'/%3E%3C/svg%3E')] bg-[length:1.25rem_1.25rem] bg-[right_0.75rem_center] bg-no-repeat pr-10 ${className}`,
      })}
    >
      {children}
    </select>
  );

  if (!label && !hint && !error) return control;

  return (
    <Field label={label} hint={hint} error={error} required={required}>
      {control}
    </Field>
  );
});

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string;
  hint?: ReactNode;
  error?: ReactNode;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, className = "", value, required, ...props },
  ref
) {
  const control = (
    <textarea
      ref={ref}
      {...props}
      required={required}
      value={value !== undefined ? (value ?? "") : undefined}
      className={controlClasses({ invalid: Boolean(error), className: `min-h-24 ${className}` })}
    />
  );

  if (!label && !hint && !error) return control;

  return (
    <Field label={label} hint={hint} error={error} required={required}>
      {control}
    </Field>
  );
});
