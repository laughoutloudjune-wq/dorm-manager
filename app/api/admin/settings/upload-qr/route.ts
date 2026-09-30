import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";

/**
 * Server-side counterpart to the payment-method QR upload that used to
 * write straight into the payment-methods storage bucket from the browser
 * with the anon key (app/(admin)/settings/page.tsx, finding C1). Same
 * "settings.payment_methods" gate as save_payment_methods.
 */
export async function POST(req: Request) {
  const auth = await requireAdminPermission(req, "settings.payment_methods");
  if ("error" in auth) return auth.error;

  try {
    const formData = await req.formData();
    const file = formData.get("file");
    const methodId = String(formData.get("methodId") ?? "");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing file." }, { status: 400 });
    }
    if (!methodId) {
      return NextResponse.json({ error: "Missing methodId." }, { status: 400 });
    }

    const path = `payment-methods/${methodId}/${Date.now()}-${file.name}`;
    const bytes = Buffer.from(await file.arrayBuffer());

    const { error: uploadError } = await auth.supabase.storage
      .from("payment-methods")
      .upload(path, bytes, { upsert: true, contentType: file.type || undefined });
    if (uploadError) {
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    const { data } = auth.supabase.storage.from("payment-methods").getPublicUrl(path);
    return NextResponse.json({ url: data.publicUrl });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
  }
}
