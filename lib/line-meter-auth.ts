import { createAdminClient } from "@/lib/supabase-admin";

const adminLineUserIds = (process.env.LINE_ADMIN_USER_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const meterLineUserIdsFromEnv = (process.env.LINE_METER_USER_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

/** Admins always allowed; env list is legacy bootstrap; DB `line_meter_users` is source of truth. */
export async function isLineMeterStaffAllowed(lineUserId: string): Promise<boolean> {
  const id = String(lineUserId ?? "").trim();
  if (!id) return false;
  if (adminLineUserIds.includes(id)) return true;
  if (meterLineUserIdsFromEnv.includes(id)) return true;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("line_meter_users")
    .select("id")
    .eq("line_user_id", id)
    .eq("status", "active")
    .maybeSingle();

  if (error) return false;
  return Boolean(data?.id);
}
