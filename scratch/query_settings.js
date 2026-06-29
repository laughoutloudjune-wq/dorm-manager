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

  const { data: settings, error } = await supabase.from("settings").select("*");
  console.log(settings);
}
main().catch(console.error);
