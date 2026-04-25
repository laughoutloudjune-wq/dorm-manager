// components/Sidebar.tsx
'use client';

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building, Menu, X } from "lucide-react";
import { useState } from "react";
import { getAdminNav } from "./admin-nav";
import { t } from "@/lib/i18n";
import { useUiLanguage } from "@/lib/use-ui-language";

export default function Sidebar() {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const locale = useUiLanguage();
  const adminNav = getAdminNav(locale);

  return (
    <>
      <header className="fixed left-0 right-0 top-0 z-30 flex items-center justify-between border-b border-slate-800/80 bg-slate-950/95 px-4 py-3 text-white shadow-soft backdrop-blur-md animate-fade-in-down md:hidden">
        <Link href="/" className="inline-flex items-center gap-2 text-lg font-semibold tracking-tight">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-cyan-500 text-white shadow-lg ring-1 ring-white/10">
            <Building size={18} />
          </span>
          Apartment Flow
        </Link>
        <button
          onClick={() => setIsOpen((open) => !open)}
          className="p-2 rounded-lg hover:bg-slate-800 transition"
          aria-label="Toggle navigation"
        >
          {isOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      </header>

      <aside className="fixed hidden h-full w-64 flex-col border-r border-slate-800/80 bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900 text-white md:flex">
        <div className="animate-fade-in-down border-b border-slate-800/80 p-6">
          <Link
            href="/"
            className="inline-flex items-center gap-3 text-xl font-semibold tracking-tight transition-transform duration-200 hover:translate-x-0.5"
          >
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-cyan-500 text-white shadow-lg shadow-blue-600/30 ring-1 ring-white/10">
              <Building size={20} />
            </span>
            <span>Apartment Flow</span>
          </Link>
          <p className="mt-3 text-[0.7rem] font-medium uppercase tracking-[0.2em] text-slate-500">
            {t(locale, "admin_console")}
          </p>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-3 pb-4 animate-fade-in-up">
          {adminNav.map((item) => {
            const isActive =
              item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition duration-200 ${
                  isActive
                    ? "bg-white/[0.12] text-white shadow-inner shadow-blue-500/20 ring-1 ring-white/10"
                    : "text-slate-300 hover:bg-white/[0.06] hover:text-white"
                } `}
              >
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
                    isActive
                      ? "bg-blue-500/20 text-cyan-200"
                      : "bg-slate-800/50 text-slate-400 group-hover:bg-slate-800 group-hover:text-slate-200"
                  }`}
                >
                  <Icon size={18} />
                </span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="p-4 text-xs text-slate-500">
          <div className="rounded-xl border border-slate-800/80 bg-slate-900/50 p-3 backdrop-blur-sm">
            <p className="font-semibold text-slate-300">{t(locale, "payment_status")}</p>
            <p className="mt-1 leading-relaxed text-slate-500">{t(locale, "all_gateways_operational")}</p>
          </div>
        </div>
      </aside>

      <div
        className={`fixed left-0 top-0 z-40 h-full w-72 transform border-r border-slate-800/80 bg-gradient-to-b from-slate-950 to-slate-900 text-white transition-transform duration-300 ease-out ${
          isOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full"
        } md:hidden`}
      >
        <div className="flex items-center justify-between border-b border-slate-800/80 p-4">
          <Link href="/" className="inline-flex items-center gap-2 text-lg font-semibold tracking-tight">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-cyan-500 text-white ring-1 ring-white/10">
              <Building size={18} />
            </span>
            Apartment Flow
          </Link>
          <button
            onClick={() => setIsOpen(false)}
            className="p-2 rounded-lg hover:bg-slate-800 transition"
            aria-label="Close navigation"
          >
            <X size={18} />
          </button>
        </div>
        <nav className="space-y-0.5 p-3">
          {adminNav.map((item) => {
            const isActive =
              item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setIsOpen(false)}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition duration-200 ${
                  isActive
                    ? "bg-white/[0.12] text-white ring-1 ring-white/10"
                    : "text-slate-300 hover:bg-white/[0.06]"
                }`}
              >
                <span
                  className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                    isActive ? "bg-blue-500/20 text-cyan-200" : "bg-slate-800/60 text-slate-400"
                  }`}
                >
                  <Icon size={18} />
                </span>
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-950/60 backdrop-blur-[1px] md:hidden"
          onClick={() => setIsOpen(false)}
          aria-hidden
        />
      )}
    </>
  );
}
