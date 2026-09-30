import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";

// Same open-invoice statuses the room-search page has always filtered to.
const OPEN_STATUSES = ["pending", "partial", "overdue", "verifying"];

/**
 * Server-side counterpart to app/(public)/payment/search/page.tsx. This
 * page is deliberately public (a tenant with nothing but their room number
 * can look up their bill) — this route stays equally open, no token or
 * login required. It exists only so the browser stops reading `rooms` and
 * `invoices` directly with the anon key (finding C1, site 2 in
 * docs/audit/2026-09-29-system-audit-detailed.md).
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const roomNumber = String(body?.roomNumber ?? "").trim();
    if (!roomNumber) {
      return NextResponse.json({ error: "Missing roomNumber." }, { status: 400 });
    }

    const supabase = createAdminClient();

    const { data: room, error: roomError } = await supabase
      .from("rooms")
      .select("id")
      .eq("room_number", roomNumber)
      .maybeSingle();

    if (roomError) {
      return NextResponse.json({ error: roomError.message }, { status: 500 });
    }
    if (!room) {
      return NextResponse.json({ error: "Room number not found." }, { status: 404 });
    }

    const { data: invoices, error: invoicesError } = await supabase
      .from("invoices")
      .select("id,public_token,issue_date,total_amount,paid_amount,status")
      .eq("room_id", room.id)
      .in("status", OPEN_STATUSES)
      .order("issue_date", { ascending: false });

    if (invoicesError) {
      return NextResponse.json({ error: invoicesError.message }, { status: 500 });
    }

    return NextResponse.json({ invoices: invoices ?? [] });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
  }
}
