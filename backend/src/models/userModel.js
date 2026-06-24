const supabase = require('../../supabase/supabase')

async function findByEmail(email) {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, email, password_hash, role, department_id, email_verified, deactivated_at, failed_login_attempts, locked_until, created_at')
    .eq('email', email)
    .single()
  if (error) return null
  return data
}

async function findById(id) {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, email, role, department_id, email_verified, deactivated_at, created_at')
    .eq('id', id)
    .single()
  if (error) return null
  return data
}

async function createUser({ name, email, passwordHash, role, departmentId, verificationToken, verificationExpires }) {
  const { data, error } = await supabase
    .from('users')
    .insert([{
      name,
      email,
      password_hash: passwordHash,
      role,
      department_id: departmentId ?? null,
      email_verified: false,
      email_verification_token: verificationToken,
      email_verification_expires: verificationExpires
    }])
    .select('id, name, email, role, department_id, email_verified')
    .single()
  if (error) throw error
  return data
}

// ── Admin operations ──────────────────────────────────────────────────────────
async function listUsers() {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, email, role, department_id, email_verified, deactivated_at, created_at')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

// Patch a user's department and/or role. `fields` may contain department_id
// and/or role; only provided keys are updated.
async function updateUser(id, fields) {
  const patch = {}
  if ('department_id' in fields) patch.department_id = fields.department_id
  if ('role' in fields) patch.role = fields.role
  if (Object.keys(patch).length === 0) return null
  const { data, error } = await supabase
    .from('users')
    .update(patch)
    .eq('id', id)
    .select('id, name, email, role, department_id, email_verified, deactivated_at')
    .single()
  if (error) throw error
  return data
}

// Soft-delete: deactivate the account (login is then refused). Keeps the row so
// uploaded documents / metrics retain their provenance.
async function deactivateUser(id) {
  const { data, error } = await supabase
    .from('users')
    .update({ deactivated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, name, email, deactivated_at')
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

module.exports = { findByEmail, findById, createUser, verifyEmail, findByVerificationToken, updateFailedLoginAttempts, listUsers, updateUser, deactivateUser }