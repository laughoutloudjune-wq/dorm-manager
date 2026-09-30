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
 * Server-side counterpart to the payment-slip upload that used to POST
 * straight to Supabase Storage's REST endpoint from the browser with the
 * anon key via a raw XMLHttpRequest (for upload-progress events) — bypassing
 * even the Supabase JS client, which is why it never showed up in a grep for
 * `supabase.storage.from(` (finding C1). Both
 * app/(public)/payment/[token]/page.tsx and
 * app/(public)/payment/liff/invoices/page.tsx call this now. Gates on a real
 * LINE access token so an anonymous caller can no longer POST arbitrary
 * files into this bucket; the storage path is always the calling tenant's
 * own id, resolved server-side from that token — never a client-supplied
 * path — since the old anon-key upload also set x-upsert:true with a
 * client-chosen path, i.e. anyone could overwrite any object in the bucket
 * if they could guess or observe its path.
 */
export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");
    const accessToken = String(formData.get("accessToken") ?? "");

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
    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id")
      .eq("line_user_id", profile.userId)
      .maybeSingle();
    if (tenantError) {
      return NextResponse.json({ error: tenantError.message }, { status: 500 });
    }
    if (!tenant?.id) {
      return NextResponse.json({ error: "Tenant not found for this LINE account." }, { status: 404 });
    }

    const safeFileName = sanitizeStorageFileName(file.name);
    const path = `${tenant.id}/${Date.now()}-${safeFileName}`;
    const bytes = Buffer.from(await file.arrayBuffer());

    const { error: uploadError } = await supabase.storage
      .from("payment_slips")
      .upload(path, bytes, { upsert: true, contentType: file.type || undefined });
    if (uploadError) {
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    const { data } = supabase.storage.from("payment_slips").getPublicUrl(path);
    return NextResponse.json({ url: data.publicUrl });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
  }
}
