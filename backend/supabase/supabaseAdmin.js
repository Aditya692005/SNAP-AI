// A SECOND Supabase client, on the service_role key.
//
// supabase.js uses the anon key, which is fine for this app's tables (they all run
// `disable row level security`). Storage is different: storage.objects has RLS on and
// it cannot be disabled on hosted Supabase, so the anon key cannot touch the private
// `documents` bucket at all. service_role bypasses RLS, which is what makes a genuinely
// private bucket possible.
//
// Kept separate from the default client rather than replacing it, so that reaching for
// elevated privileges is an explicit import at each call site instead of a silent
// upgrade for every query in the app. Today only storageService.js needs it.
//
// Server-side only. This key must never reach the frontend.

const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

// Node < 22 has no native global WebSocket; Supabase's realtime client needs one.
if (!globalThis.WebSocket) {
  globalThis.WebSocket = require('ws')
}

// Fall back to the anon key rather than booting with `undefined` — createClient throws on
// a missing key, which would take the whole API down over a feature most requests never
// touch. The fallback cannot actually write to the bucket, so uploads fail with an RLS
// error; this warning is what connects that error to its cause.
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    '[storage] SUPABASE_SERVICE_ROLE_KEY is not set — falling back to the anon key. Document ' +
      'uploads and downloads WILL fail: storage.objects enforces RLS, so only the service_role ' +
      'key can reach the private documents bucket. See backend/.env.example.'
  )
}

const supabaseAdmin = createClient(process.env.SUPABASE_URL, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

module.exports = supabaseAdmin
