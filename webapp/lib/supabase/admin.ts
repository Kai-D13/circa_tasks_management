import { createClient } from '@supabase/supabase-js'

// Service role client — server-side only, bypasses RLS
// NEVER import this in client components
// Uses the internal docker-network URL when set (see lib/supabase/server.ts).
// Storage public URLs must NOT come from this client — use publicStorageUrl().
export const supabaseAdmin = createClient(
  process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
)
