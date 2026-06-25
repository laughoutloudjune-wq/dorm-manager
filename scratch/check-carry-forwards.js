const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function checkCarryForwards() {
  const { data: carryForwards, error } = await supabase
    .from("invoice_carry_forwards")
    .select(`
      source_invoice_id,
      target_invoice_id,
      source:invoices!invoice_carry_forwards_source_invoice_id_fkey(id, start_date, total_amount, paid_amount),
      target:invoices!invoice_carry_forwards_target_invoice_id_fkey(id, start_date, total_amount, paid_amount)
    `)
    .limit(10);
    
  if (error) {
    console.error("Error:", error);
  } else {
    console.log(JSON.stringify(carryForwards, null, 2));
  }
}

checkCarryForwards();
