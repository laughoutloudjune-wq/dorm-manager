import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body?.action ?? "");

    if (action === "toggle_status") {
      const auth = await requireAdminPermission(req, "room.edit");
      if ("error" in auth) return auth.error;
      const roomId = String(body?.roomId ?? "");
      const status = String(body?.status ?? "");
      const { error } = await auth.supabase.from("rooms").update({ status }).eq("id", roomId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
  }
}

