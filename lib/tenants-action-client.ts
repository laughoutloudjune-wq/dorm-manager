"use client";

import { createClient } from "@/lib/supabase-client";

/**
 * A failed POST to /api/admin/tenants/actions. Keeps the HTTP status, the
 * `code` the money/move-out actions return (`{ error, code }`), and the whole
 * body — settle_move_out's 409 `preview_changed` carries a fresh `preview`.
 */
export class TenantsActionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly body: any,
  ) {
    super(message);
  }
}

/** POST an action to /api/admin/tenants/actions with the admin's session token. */
export async function callTenantsAction<T = any>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new TenantsActionError("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่", 401, null, null);

  const res = await fetch("/api/admin/tenants/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new TenantsActionError(
      json?.error ?? `Action ${action} failed`,
      res.status,
      typeof json?.code === "string" ? json.code : null,
      json,
    );
  }
  return json as T;
}
