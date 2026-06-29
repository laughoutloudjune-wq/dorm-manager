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

  // Get rooms
  const { data: rooms } = await supabase.from("rooms").select("id, room_number").ilike("room_number", "%111/1%");
  console.log("Rooms:", rooms);

  for (const r of rooms || []) {
    const { data: invoices } = await supabase
      .from("invoices")
      .select("id, status, total_amount, paid_amount, late_fee_amount, waived_late_fee_amount, late_fee_start_date, issue_date")
      .eq("room_id", r.id);
    console.log(`Invoices for room ${r.room_number}:`, invoices);
  }
}

main().catch(console.error);
