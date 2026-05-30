"use client";

import { ReactNode, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Sidebar from "./Sidebar";
import { getAdminNav } from "./admin-nav";
import { createClient } from "@/lib/supabase-client";
import { t } from "@/lib/i18n";
import { useUiLanguage } from "@/lib/use-ui-language";
import { useRealtimeInvoices } from "@/lib/hooks/use-realtime-invoices";
import { ErrorBoundary } from "./ErrorBoundary";

const toTitle = (pathname: string, labels: ReturnType<typeof getAdminNav>) => {
  const match = labels.find((item) =>
    item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
  );
  return match?.label ?? null;
};

export default function AdminShell({ children }: { children: ReactNode }) {
  const supabase = useMemo(() => createClient(), []);
  const pathname = usePathname();
  const router = useRouter();
  const locale = useUiLanguage();
  const navItems = useMemo(() => getAdminNav(locale), [locale]);
  const [checkingSession, setCheckingSession] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const pageTitle = useMemo(
    () => toTitle(pathname, navItems) ?? t(locale, "nav_dashboard"),
    [locale, pathname, navItems]
  );
  
  useRealtimeInvoices();

  const crumbs = [
    { label: "Apartment Flow", href: "/" },
    { label: pageTitle, href: pathname },
  ];

  useEffect(() => {
    let mounted = true;

    const check = async () => {
      const { data } = await supabase.auth.getSession();
      if (!mounted) return;
      if (!data.session) {
        router.replace("/login");
        return;
      }
      setCheckingSession(false);
    };

    void check();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        router.replace("/login");
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [router, supabase]);

  const handleLogout = async () => {
    setLoggingOut(true);
    await supabase.auth.signOut();
    setLoggingOut(false);
    router.replace("/login");
  };

  if (checkingSession) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[var(--page-bg)] px-6 text-slate-500">
        <span className="inline-flex h-9 w-9 animate-pulse rounded-xl bg-gradient-to-br from-blue-500 to-cyan-500 opacity-80 shadow-lg shadow-blue-600/20" />
        <p className="text-sm font-medium text-slate-600">{t(locale, "checking_session")}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen text-slate-900">
      <Sidebar />
      <div className="pt-20 md:pl-64 md:pt-8">
        <header className="px-4 md:px-8 animate-fade-in-down">
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200/70 bg-white/80 px-4 py-3.5 shadow-soft backdrop-blur-md">
            <div>
              <nav className="text-[0.7rem] font-medium uppercase tracking-[0.18em] text-slate-400">
                {crumbs.map((crumb, index) => (
                  <span key={crumb.label}>
                    {index > 0 ? " / " : ""}
                    <span
                      className={index === crumbs.length - 1 ? "text-slate-600" : "text-slate-400"}
                    >
                      {crumb.label}
                    </span>
                  </span>
                ))}
              </nav>
              <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-slate-900 md:text-[1.75rem]">
                {pageTitle}
              </h1>
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.25)]" />
              <span className="hidden sm:inline">{t(locale, "supabase_connected")}</span>
              <button
                type="button"
                onClick={() => void handleLogout()}
                disabled={loggingOut}
                className="ml-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500/40 disabled:opacity-60"
              >
                {loggingOut ? t(locale, "signing_out") : t(locale, "logout")}
              </button>
            </div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1600px] px-4 py-5 md:px-8 md:py-7 animate-fade-in-up">
          <ErrorBoundary>
            {children}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
