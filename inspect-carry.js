import { createClient } from "@supabase/supabase-js";
import fs from "fs";

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  
  const envFile = fs.readFileSync(".env.local", "utf8");
  let url = supabaseUrl;
  let key = supabaseKey;
  for (const line of envFile.split("\n")) {
    if (line.startsWith("NEXT_PUBLIC_SUPABASE_URL=")) url = line.split("=")[1].trim().replace(/"/g, '');
    if (line.startsWith("SUPABASE_SERVICE_ROLE_KEY=")) key = line.split("=")[1].trim().replace(/"/g, '');
  }

  const supabase = createClient(url, key);

  // Reset 3/2026
  await supabase
    .from("invoices")
    .update({
      paid_amount: 3317,
      total_amount: 4763,
      status: "partial",
      waived_late_fee_amount: 999999, // Fully waive the late fee permanently
      late_fee_amount: 0,
    })
    .eq("id", "ba1ce588-c241-4768-be90-8354ada98402");
    
  // We should also fix 4/2026 to only have the remaining payment
  await supabase
    .from("invoices")
    .update({
      paid_amount: 6000,
      total_amount: 6244,
      status: "partial",
      waived_late_fee_amount: 999999,
      late_fee_amount: 0,
    })
    .eq("id", "59913917-2055-4968-8727-1c9f1a0376b0");

  console.log("Fixed test data!");
}

main().catch(console.error);
