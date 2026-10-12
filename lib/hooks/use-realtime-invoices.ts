"use client";

import { useEffect, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase-client";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import {
  INVOICE_POLL_INTERVAL_MS,
  shouldPoll,
  shouldRefreshOnVisible,
} from "@/lib/invoice-load-policy";

type InvoiceActivityRow = {
  id: string;
  room_id: string | null;
  slip_url: string | null;
  status: string;
};

/**
 * Polls for "slip just uploaded" / "just entered verifying" instead of a
 * Supabase Realtime subscription (finding C1) — Realtime meant the browser
 * held a direct, permanent connection to the database using the admin's own
 * session, separate from every other read in this app, which all now go
 * through an authenticated server route first. A toast notification isn't
 * time-critical to the second, so polling is a fine trade for closing that
 * one remaining direct connection. The first poll after mount only
 * establishes the baseline snapshot — it never fires a toast for invoices
 * that were already in that state before this admin opened the page.
 */
export function useRealtimeInvoices(onUpdate?: () => void) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const previousRef = useRef<Map<string, { slip_url: string | null; status: string }> | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) return;

      const response = await fetch("/api/admin/invoices/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "get_invoice_activity_snapshot" }),
      }).catch(() => null);
      if (!response || !response.ok || cancelled) return;

      const result = await response.json().catch(() => null);
      const rows = (result?.invoices ?? []) as InvoiceActivityRow[];
      const previous = previousRef.current;

      if (previous) {
        for (const row of rows) {
          const prev = previous.get(row.id);
          if (!prev) continue;
          if (!prev.slip_url && row.slip_url) {
            toast.info("มีการอัปโหลดสลิปใหม่", {
              description: `บิลห้อง ${row.room_id || "ไม่ทราบ"} ถูกอัปโหลดสลิปแล้ว`,
            });
            onUpdate?.();
            router.refresh();
          } else if (prev.status !== "verifying" && row.status === "verifying") {
            toast.info("สถานะบิลรอตรวจสอบ", {
              description: `บิลห้อง ${row.room_id || "ไม่ทราบ"} รอการตรวจสอบจากแอดมิน`,
            });
            onUpdate?.();
            router.refresh();
          }
        }
      }

      previousRef.current = new Map(rows.map((row) => [row.id, { slip_url: row.slip_url, status: row.status }]));
    };

    let lastPollAt: number | null = null;
    const tick = () => {
      if (!shouldPoll(document.hidden)) return;
      lastPollAt = Date.now();
      void poll();
    };

    tick();
    const interval = setInterval(tick, INVOICE_POLL_INTERVAL_MS);
    // Polling pauses while the tab is hidden; catch up when it returns so a
    // slip uploaded meanwhile still raises its toast promptly.
    const onVisible = () => {
      if (!document.hidden && shouldRefreshOnVisible({ lastPollAt, now: Date.now() })) tick();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [onUpdate, router, supabase]);
}
