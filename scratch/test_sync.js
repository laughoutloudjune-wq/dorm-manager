const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const { syncInvoiceLedger } = require("../lib/invoice-ledger");

// Note: can't easily require ts in plain node, let's just make a script that updates the 120/2 invoice to 'overdue' temporarily and then back to 'paid' to trigger the hook? No, syncInvoiceLedger is on backend. We'll let the user know.
