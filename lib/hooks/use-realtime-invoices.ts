"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase-client";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

export function useRealtimeInvoices(onUpdate?: () => void) {
  const router = useRouter();
  
  useEffect(() => {
    const supabase = createClient();
    
    // Subscribe to UPDATE events on the invoices table
    const channel = supabase
      .channel("invoices_realtime")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "invoices" },
        (payload) => {
          const oldRecord = payload.old as any;
          const newRecord = payload.new as any;
          
          // Check if a slip was just uploaded
          if (!oldRecord.slip_url && newRecord.slip_url) {
            toast.info("มีการอัปโหลดสลิปใหม่", {
              description: `บิลห้อง ${newRecord.room_id || "ไม่ทราบ"} ถูกอัปโหลดสลิปแล้ว`,
            });
            if (onUpdate) onUpdate();
            router.refresh();
          }
          // Check if status changed to verifying
          else if (oldRecord.status !== "verifying" && newRecord.status === "verifying") {
            toast.info("สถานะบิลรอตรวจสอบ", {
              description: `บิลห้อง ${newRecord.room_id || "ไม่ทราบ"} รอการตรวจสอบจากแอดมิน`,
            });
            if (onUpdate) onUpdate();
            router.refresh();
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [onUpdate, router]);
}
