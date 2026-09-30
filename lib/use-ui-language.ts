"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-client";
import { AppLocale } from "@/lib/i18n";

export function useUiLanguage(defaultLocale: AppLocale = "th") {
  const supabase = useMemo(() => createClient(), []);
  const [locale, setLocale] = useState<AppLocale>(defaultLocale);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      // Moved server-side (finding C1) — this used to read settings
      // directly from the browser with the anon key. Reuses the existing
      // /api/admin/settings GET route rather than a new endpoint, since it
      // already returns the full settings row.
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) return;

      const response = await fetch("/api/admin/settings", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!mounted || !response.ok) return;
      const result = await response.json().catch(() => ({}));
      const next = result?.settings?.ui_language;
      if (next === "en" || next === "th") setLocale(next);
    };
    void load();
    return () => {
      mounted = false;
    };
  }, [supabase]);

  return locale;
}

