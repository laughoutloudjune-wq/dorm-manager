import { InputHTMLAttributes, ReactNode } from "react";

export function Input({
  label,
  hint,
  className = "",
  value,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: ReactNode }) {
  return (
    <label className="block space-y-2 text-sm text-slate-600">
      {label && <span className="font-medium text-slate-800">{label}</span>}
      <input
        {...props}
        value={value !== undefined ? (value ?? "") : undefined}
        className={`w-full rounded-xl border border-slate-200/90 bg-white px-4 py-2.5 text-sm text-slate-900 shadow-sm transition-[border-color,box-shadow] duration-200 placeholder:text-slate-400 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 ${className}`}
      />
      {hint && <span className="block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}
