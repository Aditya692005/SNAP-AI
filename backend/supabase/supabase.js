const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

// Node < 22 has no native global WebSocket; Supabase's realtime client needs one.
if (!globalThis.WebSocket) {
  globalThis.WebSocket = require('ws')
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

module.exports = supabase
