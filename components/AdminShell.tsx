"use client";

import { ReactNode, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Sidebar from "./Sidebar";
import { adminNav } from "./admin-nav";
import { createClient } from "@/lib/supabase-client";

const toTitle = (pathname: string) => {
  const match = adminNav.find((item) =>
    item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
  );
  return match?.label ?? "Dashboard";
};

export default function AdminShell({ children }: { children: ReactNode }) {
  const supabase = useMemo(() => createClient(), []);
  const pathname = usePathname();
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const pageTitle = useMemo(() => toTitle(pathname), [pathname]);
  const crumbs = [
    { label: "DormManager", href: "/" },
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
        Checking session...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <Sidebar />
      <div className="md:pl-64 pt-20 md:pt-8">
        <header className="px-5 md:px-10">
          <div className="flex flex-wrap items-center justify-between gap-3">
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
              Supabase connected
              <button
                onClick={() => void handleLogout()}
                disabled={loggingOut}
                className="ml-3 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                {loggingOut ? "Signing out..." : "Logout"}
              </button>
            </div>
          </div>
        </header>
        <main className="px-5 md:px-10 py-6">{children}</main>
      </div>
    </div>
  );
}
