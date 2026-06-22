const supabase = require('../../supabase/supabase')

async function findByEmail(email) {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, email, password_hash, role, email_verified, failed_login_attempts, locked_until, created_at')
    .eq('email', email)
    .single()
  if (error) return null
  return data
}

async function findById(id) {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, email, role, email_verified, created_at')
    .eq('id', id)
    .single()
  if (error) return null
  return data
}

async function createUser({ name, email, passwordHash, role, verificationToken, verificationExpires }) {
  const { data, error } = await supabase
    .from('users')
    .insert([{
      name,
      email,
      password_hash: passwordHash,
      role,
      email_verified: false,
      email_verification_token: verificationToken,
      email_verification_expires: verificationExpires
    }])
    .select('id, name, email, role, email_verified')
    .single()
  if (error) throw error
  return data
}

async function verifyEmail(verificationToken) {
  const { data: user, error } = await supabase
    .from('users')
    .select('id, email, email_verification_expires')
    .eq('email_verification_token', verificationToken)
    .single()

  if (error || !user) {
    console.error('[DB] Token not found')
    return null
  }

  const expiresAt = new Date(user.email_verification_expires)
  if (expiresAt < new Date()) {
    console.error('[DB] Token expired')
    return null
  }

  const { error: updateError } = await supabase
    .from('users')
    .update({
      email_verified: true,
      email_verification_token: null,
      email_verification_expires: null
    })
    .eq('id', user.id)

  if (updateError) throw updateError
  return user
}

async function findByVerificationToken(token) {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, email')
    .eq('email_verification_token', token)
    .single()
  if (error) return null
  return data
}

async function updateFailedLoginAttempts(userId, attempts, lockedUntil) {
  const { error } = await supabase
    .from('users')
    .update({ failed_login_attempts: attempts, locked_until: lockedUntil })
    .eq('id', userId)
  if (error) throw error
}

module.exports = { findByEmail, findById, createUser, verifyEmail, findByVerificationToken, updateFailedLoginAttempts }