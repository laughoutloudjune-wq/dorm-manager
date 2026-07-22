import { ReactNode } from "react";

/**
 * Page-level scaffolding: the title block, empty/loading states, and the
 * segmented tab control. Every admin page was previously drawing its own
 * variation of each of these.
 */

/**
 * The description + actions row that sits at the top of a page.
 *
 * `title` is normally omitted: AdminShell already renders the page title from
 * the nav definition, so every page gets one for free and a second <h1> here
 * would just duplicate it. Pass `title` only on pages rendered outside the
 * admin shell.
 */
export function PageHeader({
  title,
  description,
  actions,
  className = "",
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  if (!title && !description && !actions) return null;

  return (
    <div
      className={`flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between ${className}`}
    >
      <div className="min-w-0">
        {title ? (
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
            {title}
          </h1>
        ) : null}
        {description ? (
          <p className={`text-sm leading-relaxed text-slate-500 ${title ? "mt-1" : ""}`}>
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">{actions}</div>
      ) : null}
    </div>
  );
}

/**
 * Segmented control, in the style of an iOS segmented picker: a sunken track
 * with a single raised white "thumb" marking the active option.
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className = "",
}: {
  items: { value: T; label: ReactNode; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={`inline-flex flex-wrap items-center gap-1 rounded-control bg-slate-100/80 p-1 ${className}`}
    >
      {items.map((item) => {
        const isActive = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(item.value)}
            className={`inline-flex items-center gap-2 rounded-[0.5rem] px-3.5 py-1.5 text-sm font-medium transition-all duration-200 ease-float ${
              isActive
                ? "bg-white text-slate-900 shadow-float"
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            {item.label}
            {typeof item.count === "number" && (
              <span
                className={`rounded-full px-1.5 py-0.5 text-2xs font-semibold ${
                  isActive ? "bg-primary-50 text-primary-700" : "bg-slate-200/80 text-slate-600"
                }`}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = "",
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center justify-center px-6 py-14 text-center ${className}`}>
      {icon ? (
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-card bg-slate-100 text-slate-400">
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-sm leading-relaxed text-slate-500">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** Shimmering placeholder block, sized by the caller. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-card bg-slate-200/60 ${className}`} />;
}

/**
 * Inline notice. Replaces the assorted hand-rolled coloured alert divs — same
 * three tones, one shape.
 */
export function Notice({
  tone = "info",
  icon,
  title,
  children,
  className = "",
}: {
  tone?: "info" | "success" | "warning" | "danger";
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const tones = {
    info: "border-primary-200/70 bg-primary-50/80 text-primary-900",
    success: "border-success-200/70 bg-success-50/80 text-success-900",
    warning: "border-warning-200/70 bg-warning-50/80 text-warning-900",
    danger: "border-danger-200/70 bg-danger-50/80 text-danger-900",
  } as const;

  return (
    <div className={`rounded-card border px-4 py-3.5 ${tones[tone]} ${className}`}>
      <div className="flex items-start gap-3">
        {icon ? <span className="mt-0.5 shrink-0">{icon}</span> : null}
        <div className="min-w-0 flex-1 text-sm leading-relaxed">
          {title ? <p className="font-semibold">{title}</p> : null}
          {children ? <div className={title ? "mt-1 opacity-90" : ""}>{children}</div> : null}
        </div>
      </div>
    </div>
  );
}
