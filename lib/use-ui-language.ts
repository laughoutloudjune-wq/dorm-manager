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
      const { data } = await supabase.from("settings").select("ui_language").eq("id", 1).maybeSingle();
      if (!mounted) return;
      const next = (data as any)?.ui_language;
      if (next === "en" || next === "th") setLocale(next);
    };
    void load();
    return () => {
      mounted = false;
    };
  }, [supabase]);

  return locale;
}

