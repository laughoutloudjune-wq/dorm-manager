import { InputHTMLAttributes, ReactNode } from "react";

export function Input({
  label,
  hint,
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: ReactNode }) {
  return (
    <label className="block space-y-2 text-sm text-slate-600">
      {label && <span className="font-medium text-slate-700">{label}</span>}
      <input
        {...props}
        className={`w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-600/40 ${className}`}
      />
      {hint && <span className="block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}
