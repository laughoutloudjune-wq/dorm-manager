import { createClient } from "@supabase/supabase-js";
import fs from "fs";

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  
  // Create a local .env parser just in case
  const envFile = fs.readFileSync(".env.local", "utf8");
  let url = supabaseUrl;
  let key = supabaseKey;
  for (const line of envFile.split("\n")) {
    if (line.startsWith("NEXT_PUBLIC_SUPABASE_URL=")) url = line.split("=")[1].trim().replace(/"/g, '');
    if (line.startsWith("SUPABASE_SERVICE_ROLE_KEY=")) key = line.split("=")[1].trim().replace(/"/g, '');
  }

  const supabase = createClient(url, key);

  const { data, error } = await supabase
    .from("invoices")
    .select("id, status, total_amount, rent_amount, water_bill, electricity_bill, late_fee_amount, locked_late_fee_amount, waived_late_fee_amount, late_fee_start_date, late_fee_per_day, additional_fees_breakdown")
    .gte("start_date", "2026-03-01")
    .lte("start_date", "2026-03-31")
    .eq("status", "partial");

  if (error) {
    console.error("Error:", error);
    return;
  }

  console.log(JSON.stringify(data, null, 2));
}

main().catch(console.error);
