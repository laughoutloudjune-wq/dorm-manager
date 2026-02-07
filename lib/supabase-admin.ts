import { createClient } from "@supabase/supabase-js";

export const createAdminClient = () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  return createClient(url, serviceKey ?? anonKey, {
    auth: { persistSession: false },
  });
};
