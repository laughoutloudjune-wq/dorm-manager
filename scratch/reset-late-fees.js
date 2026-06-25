const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
// Using service role key if available, otherwise anon key
const adminKey = process.env.SUPABASE_SERVICE_ROLE_KEY || supabaseKey;

const supabase = createClient(supabaseUrl, adminKey);

async function resetLateFees() {
  console.log("Fetching all open invoices...");
  const { data: invoices, error } = await supabase
    .from("invoices")
    .select("id, status, late_fee_amount, locked_late_fee_amount")
    .in("status", ["pending", "overdue", "partial", "verifying"]);
  
  if (error) {
    console.error("Error fetching invoices:", error);
    return;
  }

  let resetCount = 0;
  for (const invoice of invoices) {
    if (invoice.locked_late_fee_amount === null && Number(invoice.late_fee_amount) > 0) {
      console.log(`Resetting invoice ${invoice.id} late_fee_amount to 0`);
      const { error: updateError } = await supabase
        .from("invoices")
        .update({ late_fee_amount: 0 })
        .eq("id", invoice.id);
        
      if (updateError) {
        console.error(`Failed to update invoice ${invoice.id}:`, updateError);
      } else {
        resetCount++;
      }
    }
  }

  console.log(`Successfully reset late fees for ${resetCount} invoices.`);
}

resetLateFees();
