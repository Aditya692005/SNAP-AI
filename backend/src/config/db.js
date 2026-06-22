const supabase = require('../../supabase/supabase')

async function connectWithRetry() {
  try {
    const { error } = await supabase.from('users').select('id').limit(1)
    if (error) throw error
    console.log('Connected to Supabase successfully')
  } catch (err) {
    throw new Error(`Supabase connection failed: ${err.message}`)
  }
}

module.exports = { connectWithRetry }