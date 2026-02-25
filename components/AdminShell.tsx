"use client";

import { ReactNode, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Sidebar from "./Sidebar";
import { getAdminNav } from "./admin-nav";
import { createClient } from "@/lib/supabase-client";
import { t } from "@/lib/i18n";
import { useUiLanguage } from "@/lib/use-ui-language";

const toTitle = (pathname: string, labels: ReturnType<typeof getAdminNav>) => {
  const match = labels.find((item) =>
    item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
  );
  return match?.label ?? "Dashboard";
};

export default function AdminShell({ children }: { children: ReactNode }) {
  const supabase = useMemo(() => createClient(), []);
  const pathname = usePathname();
  const router = useRouter();
  const locale = useUiLanguage();
  const navItems = useMemo(() => getAdminNav(locale), [locale]);
  const [checkingSession, setCheckingSession] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const pageTitle = useMemo(() => toTitle(pathname, navItems), [pathname, navItems]);
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
        <div className="min-h-screen bg-slate-50 px-6 py-10 text-sm text-slate-500">
        {t(locale, "checking_session")}
        </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <Sidebar />
      <div className="md:pl-64 pt-20 md:pt-8">
        <header className="px-5 md:px-10 animate-fade-in-down">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200/80 bg-white/70 px-4 py-3 shadow-sm backdrop-blur">
            <div>
              <nav className="text-xs uppercase tracking-[0.2em] text-slate-400">
                {crumbs.map((crumb, index) => (
                  <span key={crumb.label}>
                    {index > 0 ? " / " : ""}
                    <span className={index === crumbs.length - 1 ? "text-slate-500" : ""}>
                      {crumb.label}
                    </span>
                  </span>
                ))}
              </nav>
              <h1 className="text-2xl md:text-3xl font-semibold text-slate-900 mt-2">
                {pageTitle}
              </h1>
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <span className="inline-flex h-2.5 w-2.5 rounded-full bg-green-500" />
              {t(locale, "supabase_connected")}
              <button
                onClick={() => void handleLogout()}
                disabled={loggingOut}
                className="ml-3 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:-translate-y-0.5 hover:bg-slate-50 disabled:opacity-60"
              >
                {loggingOut ? t(locale, "signing_out") : t(locale, "logout")}
              </button>
            </div>
          </div>
        </header>
        <main className="px-5 md:px-10 py-6 animate-fade-in-up">{children}</main>
      </div>
    </div>
  );
}
