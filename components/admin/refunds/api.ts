import { createClient } from "@/lib/supabase-client";

/** POST to the refunds actions route with the admin bearer token. Throws Error(message) with the server's Thai message. */
export async function postRefundAction<T = any>(body: Record<string, unknown>): Promise<T> {
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Session expired. Please log in again.");
  const res = await fetch("/api/admin/refunds/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error ?? "ทำรายการไม่สำเร็จ");
  return json as T;
}
