import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body?.action ?? "");

    if (action === "save_general") {
      const auth = await requireAdminPermission(req, "settings.general");
      if ("error" in auth) return auth.error;
      const payload = body?.payload ?? {};
      const { error } = await auth.supabase.from("settings").update(payload).eq("id", 1);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    if (action === "save_utilities") {
      const auth = await requireAdminPermission(req, "settings.utilities");
      if ("error" in auth) return auth.error;
      const { error } = await auth.supabase.from("settings").update(body?.payload ?? {}).eq("id", 1);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    if (action === "save_invoice_config") {
      const auth = await requireAdminPermission(req, "settings.invoice_config");
      if ("error" in auth) return auth.error;
      const { error } = await auth.supabase.from("settings").update(body?.payload ?? {}).eq("id", 1);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    if (action === "save_payment_methods") {
      const auth = await requireAdminPermission(req, "settings.payment_methods");
      if ("error" in auth) return auth.error;
      const methods = Array.isArray(body?.methods) ? body.methods : [];
      const initialMethodIds = Array.isArray(body?.initialMethodIds) ? body.initialMethodIds : [];

      const existingIdSet = new Set(initialMethodIds);
      const existingRows = methods.filter((row: any) => row.id && existingIdSet.has(row.id));
      const newRows = methods.filter((row: any) => !row.id || !existingIdSet.has(row.id)).map(({ id, ...rest }: any) => rest);

      for (const row of existingRows) {
        const { id, ...payload } = row;
        const { error } = await auth.supabase.from("payment_methods").update(payload).eq("id", id);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      }
      if (newRows.length > 0) {
        const { error } = await auth.supabase.from("payment_methods").insert(newRows);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      }
      const currentIds = existingRows.map((r: any) => r.id).filter(Boolean);
      const removedIds = (initialMethodIds as string[]).filter((id) => !currentIds.includes(id));
      if (removedIds.length > 0) {
        const { error } = await auth.supabase.from("payment_methods").delete().in("id", removedIds);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      }
      return NextResponse.json({ success: true });
    }

    if (action === "save_receipt_profiles") {
      const auth = await requireAdminPermission(req, "settings.payment_methods");
      if ("error" in auth) return auth.error;
      const profiles = Array.isArray(body?.profiles) ? body.profiles : [];
      const initialProfileIds = Array.isArray(body?.initialProfileIds) ? body.initialProfileIds : [];

      const existingIdSet = new Set(initialProfileIds);
      const existingRows = profiles.filter((row: any) => row.id && existingIdSet.has(row.id));
      const newRows = profiles
        .filter((row: any) => !row.id || !existingIdSet.has(row.id))
        .map(({ id, ...rest }: any) => rest);

      for (const row of existingRows) {
        const { id, ...payload } = row;
        const { error } = await auth.supabase.from("receipt_profiles").update(payload).eq("id", id);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      }
      if (newRows.length > 0) {
        const { error } = await auth.supabase.from("receipt_profiles").insert(newRows);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      }
      const currentIds = existingRows.map((r: any) => r.id).filter(Boolean);
      const removedIds = (initialProfileIds as string[]).filter((id) => !currentIds.includes(id));
      if (removedIds.length > 0) {
        const { error } = await auth.supabase.from("receipt_profiles").delete().in("id", removedIds);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      }
      return NextResponse.json({ success: true });
    }

    if (action === "add_building") {
      const auth = await requireAdminPermission(req, "settings.rooms");
      if ("error" in auth) return auth.error;
      const payload = body?.payload ?? {};
      const { data, error } = await auth.supabase.from("buildings").insert(payload).select("id,name").single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true, data });
    }

    if (action === "add_room") {
      const auth = await requireAdminPermission(req, "settings.rooms");
      if ("error" in auth) return auth.error;
      const { error } = await auth.supabase.from("rooms").insert(body?.payload ?? {});
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    if (action === "save_rooms") {
      const auth = await requireAdminPermission(req, "settings.rooms");
      if ("error" in auth) return auth.error;
      const rooms = Array.isArray(body?.rooms) ? body.rooms : [];
      for (const room of rooms) {
        const { id, ...payload } = room;
        const { error } = await auth.supabase.from("rooms").update(payload).eq("id", id);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      }
      return NextResponse.json({ success: true });
    }

    if (action === "delete_room") {
      const auth = await requireAdminPermission(req, "settings.rooms");
      if ("error" in auth) return auth.error;
      const roomId = String(body?.roomId ?? "");
      const { error } = await auth.supabase.from("rooms").delete().eq("id", roomId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    if (action === "save_permissions") {
      const auth = await requireAdminPermission(req, "settings.permissions");
      if ("error" in auth) return auth.error;
      const { error } = await auth.supabase
        .from("settings")
        .update({ role_permissions: body?.role_permissions ?? {}, updated_at: new Date().toISOString() })
        .eq("id", 1);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
  }
}
