// components/Sidebar.tsx
'use client';

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building, Menu, X } from "lucide-react";
import { useState } from "react";
import { adminNav } from "./admin-nav";

export default function Sidebar() {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <header className="md:hidden bg-slate-900 text-white px-4 py-3 flex items-center justify-between fixed top-0 left-0 right-0 z-30 shadow-md">
        <Link href="/" className="inline-flex items-center gap-2 text-lg font-semibold">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white">
            <Building size={18} />
          </span>
          DormManager
        </Link>
        <button
          onClick={() => setIsOpen((open) => !open)}
          className="p-2 rounded-lg hover:bg-slate-800 transition"
          aria-label="Toggle navigation"
        >
          {isOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      </header>

      <aside className="hidden md:flex md:flex-col md:w-64 bg-slate-900 text-white fixed h-full">
        <div className="p-6 border-b border-slate-800">
          <Link href="/" className="inline-flex items-center gap-3 text-xl font-semibold">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-blue-600 text-white">
              <Building size={20} />
            </span>
            DormManager
          </Link>
          <p className="mt-3 text-xs uppercase tracking-[0.2em] text-slate-400">
            Admin Console
          </p>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          {adminNav.map((item) => {
            const isActive =
              item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition ${
                  isActive
                    ? "bg-blue-600 text-white shadow-lg shadow-blue-600/20"
                    : "text-slate-200 hover:bg-slate-800"
                }`}
              >
                <Icon size={18} />
                <span className="text-sm font-medium">{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="p-4 text-xs text-slate-500">
          <div className="rounded-xl border border-slate-800 p-3">
            <p className="font-semibold text-slate-300">Payment Status</p>
            <p className="mt-1 text-slate-500">All gateways operational.</p>
          </div>
        </div>
      </aside>

      <div
        className={`fixed top-0 left-0 h-full w-72 bg-slate-900 text-white z-40 transform transition-transform duration-300 ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        } md:hidden`}
      >
        <div className="p-4 flex items-center justify-between border-b border-slate-800">
          <Link href="/" className="inline-flex items-center gap-2 text-lg font-semibold">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white">
              <Building size={18} />
            </span>
            DormManager
          </Link>
          <button
            onClick={() => setIsOpen(false)}
            className="p-2 rounded-lg hover:bg-slate-800 transition"
            aria-label="Close navigation"
          >
            <X size={18} />
          </button>
        </div>
        <nav className="p-4 space-y-1">
          {adminNav.map((item) => {
            const isActive =
              item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setIsOpen(false)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition ${
                  isActive
                    ? "bg-blue-600 text-white shadow-lg shadow-blue-600/20"
                    : "text-slate-200 hover:bg-slate-800"
                }`}
              >
                <Icon size={18} />
                <span className="text-sm font-medium">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  );
}
