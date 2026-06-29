const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");

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

  // Get room 120/2
  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select("id, room_number")
    .ilike("room_number", "%120/2%")
    .maybeSingle();

  if (roomError || !room) {
    console.error("Room 120/2 not found", roomError);
    return;
  }

  const { data: invoices, error } = await supabase
    .from("invoices")
    .select("id, status, total_amount, paid_amount, late_fee_amount, waived_late_fee_amount, late_fee_start_date, late_fee_per_day, issue_date, due_date, payment_history, additional_fees_breakdown")
    .eq("room_id", room.id)
    .order("issue_date", { ascending: false });

  if (error) {
    console.error("Error fetching invoices", error);
    return;
  }

  console.log(JSON.stringify(invoices, null, 2));
}

main().catch(console.error);
