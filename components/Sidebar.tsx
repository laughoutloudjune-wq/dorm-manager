// components/Sidebar.tsx
'use client';

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building, Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { getAdminNav } from "./admin-nav";
import { t } from "@/lib/i18n";
import { useUiLanguage } from "@/lib/use-ui-language";

/**
 * Light, floating navigation rail.
 *
 * The rail is inset from the viewport edges rather than flush against them, so
 * it reads as a panel resting on the page canvas — the same treatment every
 * other surface in the app gets. The active item is marked with a tinted fill
 * plus a small accent bar; hue alone shouldn't be the only signal.
 */

function NavList({
  onNavigate,
  className = "",
}: {
  onNavigate?: () => void;
  className?: string;
}) {
  const pathname = usePathname();
  const locale = useUiLanguage();
  const adminNav = getAdminNav(locale);

  return (
    <nav className={`space-y-0.5 ${className}`}>
      {adminNav.map((item) => {
        const isActive =
          item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            prefetch={false}
            onClick={onNavigate}
            aria-current={isActive ? "page" : undefined}
            className={`group relative flex items-center gap-3 rounded-control px-3 py-2.5 text-sm font-medium transition-all duration-200 ease-float ${
              isActive
                ? "bg-primary-50 text-primary-700"
                : "text-slate-600 hover:bg-slate-100/80 hover:text-slate-900"
            }`}
          >
            {isActive && (
              <span
                className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-primary-600"
                aria-hidden
              />
            )}
            <span
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[0.625rem] transition-colors duration-200 ${
                isActive
                  ? "bg-primary-600 text-white shadow-float"
                  : "bg-slate-100 text-slate-500 group-hover:bg-white group-hover:text-slate-700 group-hover:shadow-float"
              }`}
            >
              <Icon size={17} />
            </span>
            <span className="truncate">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <Link
      href="/"
      className="inline-flex items-center gap-3 text-base font-semibold tracking-tight text-slate-900 transition-transform duration-200 ease-float hover:translate-x-0.5"
    >
      <span
        className={`inline-flex items-center justify-center rounded-[0.75rem] bg-primary-600 text-white shadow-float-md ${
          compact ? "h-9 w-9" : "h-10 w-10"
        }`}
      >
        <Building size={compact ? 18 : 20} />
      </span>
      <span>Apartment Flow</span>
    </Link>
  );
}

export default function Sidebar() {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const locale = useUiLanguage();

  // Close the drawer whenever the route changes, so tapping a link doesn't
  // leave the overlay hanging over the page it just navigated to.
  useEffect(() => {
    setIsOpen(false);
  }, [pathname]);

  return (
    <>
      {/* Mobile top bar */}
      <header className="animate-fade-in-plain fixed left-0 right-0 top-0 z-30 flex items-center justify-between border-b border-slate-200/70 bg-white/80 px-4 py-2.5 backdrop-blur-xl md:hidden">
        <Wordmark compact />
        <button
          onClick={() => setIsOpen((open) => !open)}
          className="rounded-control p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
          aria-label="Toggle navigation"
          aria-expanded={isOpen}
        >
          {isOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      </header>

      {/* Desktop rail — inset from the edges so it floats rather than docks. */}
      <aside className="fixed inset-y-4 left-4 z-20 hidden w-60 flex-col rounded-panel border border-slate-200/70 bg-white/75 shadow-float-lg backdrop-blur-xl md:flex">
        <div className="animate-fade-in-down px-5 pb-4 pt-6">
          <Wordmark />
          <p className="mt-3 text-2xs font-semibold uppercase tracking-[0.16em] text-slate-400">
            {t(locale, "admin_console")}
          </p>
        </div>
        <div className="mx-5 h-px bg-slate-200/70" />
        <div className="scrollbar-slim flex-1 overflow-y-auto p-3 animate-fade-in-up">
          <NavList />
        </div>
        <div className="p-3">
          <div className="rounded-control border border-slate-200/70 bg-slate-50/80 p-3">
            <p className="flex items-center gap-2 text-xs font-semibold text-slate-700">
              <span className="h-1.5 w-1.5 rounded-full bg-success-500 shadow-[0_0_0_3px_rgba(16,185,129,0.18)]" />
              {t(locale, "payment_status")}
            </p>
            <p className="mt-1 text-2xs leading-relaxed text-slate-500">
              {t(locale, "all_gateways_operational")}
            </p>
          </div>
        </div>
      </aside>

      {/* Mobile drawer */}
      <div
        className={`fixed inset-y-3 left-3 z-40 flex w-64 transform flex-col rounded-panel border border-slate-200/70 bg-white/90 shadow-float-xl backdrop-blur-xl transition-transform duration-300 ease-float md:hidden ${
          isOpen ? "translate-x-0" : "-translate-x-[110%]"
        }`}
      >
        <div className="flex items-center justify-between px-4 py-4">
          <Wordmark compact />
          <button
            onClick={() => setIsOpen(false)}
            className="rounded-control p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close navigation"
          >
            <X size={18} />
          </button>
        </div>
        <div className="mx-4 h-px bg-slate-200/70" />
        <div className="scrollbar-slim flex-1 overflow-y-auto p-3">
          <NavList onNavigate={() => setIsOpen(false)} />
        </div>
      </div>

      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/20 backdrop-blur-sm md:hidden"
          onClick={() => setIsOpen(false)}
          aria-hidden
        />
      )}
    </>
  );
}
