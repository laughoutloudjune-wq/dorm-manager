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
import { Button } from "./ui/Button";

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
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6">
        <span className="inline-flex h-10 w-10 animate-pulse rounded-[0.75rem] bg-primary-600 opacity-90 shadow-float-md" />
        <p className="text-sm font-medium text-slate-500">{t(locale, "checking_session")}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen text-slate-900">
      <Sidebar />
      {/* Left padding clears the floating rail: 1rem inset + 15rem rail + 1rem gutter. */}
      <div className="pt-[4.5rem] md:pl-[17rem] md:pt-4">
        {/* `header` must be a DIRECT sibling of `main` inside this shared
            scroll container, not wrapped in its own gutter <div>. A sticky
            element can't stick past the bottom of its own containing block —
            an earlier version wrapped header in a `<div className="px-4
            md:pr-4">` to keep that padding off the glass layer below, and
            that wrapper's only child was the header, so its box was exactly
            as tall as the header itself. The moment you scrolled past that
            (immediately), the header had nowhere left to stick to and just
            scrolled away. The gutter padding has to live on `header` itself,
            so its containing block is this tall, page-spanning div instead.

            Sticky and the glass fill are still kept on separate elements
            (relative wrapper -> absolute `.surface-frosted` layer -> relative
            content layer) as a defensive measure against backdrop-filter
            compositing oddities when mixed with position:sticky, even though
            the sticky bug above turned out to be the real cause here. */}
        <header className="animate-fade-in-plain sticky top-2 z-10 px-4 md:top-4 md:pr-4">
          <div className="relative mx-auto max-w-[1600px]">
            <div className="surface-frosted absolute inset-0 z-0" aria-hidden />
            <div className="relative z-10 flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
              <div className="min-w-0">
                <nav className="text-2xs font-semibold uppercase tracking-[0.16em] text-slate-400">
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
                <h1 className="mt-1 truncate text-xl font-semibold tracking-tight text-slate-900 md:text-2xl">
                  {pageTitle}
                </h1>
              </div>
              <div className="flex items-center gap-2.5 text-sm text-slate-500">
                <span className="hidden items-center gap-2 rounded-full border border-slate-200/80 bg-white/70 px-2.5 py-1 text-xs font-medium text-slate-600 sm:inline-flex">
                  <span className="h-1.5 w-1.5 rounded-full bg-success-500 shadow-[0_0_0_3px_rgba(16,185,129,0.18)]" />
                  {t(locale, "supabase_connected")}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void handleLogout()}
                  loading={loggingOut}
                >
                  {loggingOut ? t(locale, "signing_out") : t(locale, "logout")}
                </Button>
              </div>
            </div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1600px] px-4 py-5 md:pr-4 md:py-6 animate-fade-in-up">
          <ErrorBoundary>
            {children}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
