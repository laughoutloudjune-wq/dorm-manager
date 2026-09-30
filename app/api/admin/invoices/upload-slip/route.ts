import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";

/**
 * Server-side counterpart to uploadSlipFile in lib/hooks/use-invoices-state.ts,
 * which used to upload straight into the payment_slips storage bucket from
 * the browser with the anon key (finding C1) — used by both the single-
 * payment and split-payment "attach a slip" flows.
 */
export async function POST(req: Request) {
  const auth = await requireAdminPermission(req, "invoice.payment.record");
  if ("error" in auth) return auth.error;

  try {
    const formData = await req.formData();
    const file = formData.get("file");
    const invoiceId = String(formData.get("invoiceId") ?? "");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing file." }, { status: 400 });
    }
    if (!invoiceId) {
      return NextResponse.json({ error: "Missing invoiceId." }, { status: 400 });
    }

    const path = `${invoiceId}/${Date.now()}-${file.name}`;
    const bytes = Buffer.from(await file.arrayBuffer());

    const { error: uploadError } = await auth.supabase.storage
      .from("payment_slips")
      .upload(path, bytes, { upsert: true, contentType: file.type || undefined });
    if (uploadError) {
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    const { data } = auth.supabase.storage.from("payment_slips").getPublicUrl(path);
    return NextResponse.json({ url: data.publicUrl });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
  }
}
