import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { verifyLineAccessToken } from "@/lib/line-admin-auth";

const sanitizeStorageFileName = (fileName: string) =>
  fileName
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(-80) || "file";

/**
 * Server-side counterpart to the deposit-slip upload that used to write
 * straight into the `tenant-docs` storage bucket from the browser with the
 * anon key (app/register/page.tsx, finding C1/C2). This is the public,
 * pre-registration flow — there's no admin session yet, so this gates on a
 * valid LINE access token instead of requireAdminPermission, matching how
 * the rest of /api/register works.
 */
export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");
    const accessToken = String(formData.get("accessToken") ?? "");
    const roomNumber = String(formData.get("roomNumber") ?? "").trim() || "unknown-room";

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing file." }, { status: 400 });
    }
    if (!accessToken) {
      return NextResponse.json({ error: "Missing accessToken." }, { status: 401 });
    }
    const profile = await verifyLineAccessToken(accessToken);
    if (!profile?.userId) {
      return NextResponse.json({ error: "LINE profile verification failed" }, { status: 401 });
    }

    const supabase = createAdminClient();
    const safeFileName = sanitizeStorageFileName(file.name);
    const path = `tenant-docs/register/${roomNumber}/new-tenant-${Date.now()}-${safeFileName}`;
    const bytes = Buffer.from(await file.arrayBuffer());

    const { error: uploadError } = await supabase.storage
      .from("tenant-docs")
      .upload(path, bytes, { upsert: true, contentType: file.type || undefined });
    if (uploadError) {
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    const { data } = supabase.storage.from("tenant-docs").getPublicUrl(path);
    return NextResponse.json({ url: data.publicUrl });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
  }
}
