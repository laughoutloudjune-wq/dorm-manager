import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";
import { sanitizeStorageFileName } from "@/lib/tenant-utils";

/**
 * Server-side counterpart to the deposit-slip upload that used to write
 * straight into the `tenant-docs` storage bucket from the browser with the
 * anon key (components/admin/tenant-editor-modal.tsx, finding C1). Gated
 * the same way saving a tenant already is ("tenant.edit").
 */
export async function POST(req: Request) {
  const auth = await requireAdminPermission(req, "tenant.edit");
  if ("error" in auth) return auth.error;

  try {
    const formData = await req.formData();
    const file = formData.get("file");
    const tenantId = String(formData.get("tenantId") ?? "");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing file." }, { status: 400 });
    }
    if (!tenantId) {
      return NextResponse.json({ error: "Missing tenantId." }, { status: 400 });
    }

    const safeFileName = sanitizeStorageFileName(file.name);
    const path = `tenant-docs/${tenantId}/${Date.now()}-${safeFileName}`;
    const bytes = Buffer.from(await file.arrayBuffer());

    const { error: uploadError } = await auth.supabase.storage
      .from("tenant-docs")
      .upload(path, bytes, { upsert: true, contentType: file.type || undefined });
    if (uploadError) {
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    const { data } = auth.supabase.storage.from("tenant-docs").getPublicUrl(path);
    return NextResponse.json({ url: data.publicUrl });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
  }
}
