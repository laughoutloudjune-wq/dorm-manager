import { createClient } from '@supabase/supabase-js'

// These lines read the keys you put in .env.local
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// This creates the "connection" that we can use in other files
export const supabase = createClient(supabaseUrl, supabaseKey)