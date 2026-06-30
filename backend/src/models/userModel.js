const supabase = require("../../supabase/supabase");

// v2 users: uuid ids, organization_id (NOT NULL), role_id -> roles, and a
// `status` column (ACTIVE / SUSPENDED / INACTIVE) in place of the old
// `deactivated_at`. The role NAME is pulled via a join and flattened onto the
// returned object as `role` so the rest of the app keeps working with a string.
// NOTE: there are two FKs between users and roles (users.role_id -> roles.id
// AND roles.created_by -> users.id), so the embed must name the exact FK
// (users_role_id_fkey) or PostgREST errors with PGRST201 (ambiguous).
const USER_SELECT =
  "id, name, email, status, organization_id, department_id, role_id, email_verified, created_at, role:roles!users_role_id_fkey(name)";

function flatten(u) {
  if (!u) return u;
  const { role, ...rest } = u;
  return { ...rest, role: role?.name ?? null };
}

async function findByEmail(email) {
  const { data, error } = await supabase
    .from("users")
    .select(`${USER_SELECT}, password_hash, failed_login_attempts, locked_until`)
    .eq("email", email)
    .single();
  if (error) return null;
  return flatten(data);
}

async function findById(id) {
  const { data, error } = await supabase
    .from("users")
    .select(USER_SELECT)
    .eq("id", id)
    .single();
  if (error) return null;
  return flatten(data);
}

async function createUser({
  name,
  email,
  passwordHash,
  organizationId,
  roleId,
  departmentId = null,
  verificationToken,
  verificationExpires,
}) {
  const { data, error } = await supabase
    .from("users")
    .insert([
      {
        name,
        email,
        password_hash: passwordHash,
        organization_id: organizationId,
        role_id: roleId,
        department_id: departmentId,
        status: "ACTIVE",
        email_verified: false,
        email_verification_token: verificationToken,
        email_verification_expires: verificationExpires,
      },
    ])
    .select(USER_SELECT)
    .single();
  if (error) throw error;
  return flatten(data);
}

// ── Admin operations (always scoped to the admin's own organization) ──────────
async function listUsers(organizationId) {
  const { data, error } = await supabase
    .from("users")
    .select(USER_SELECT)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(flatten);
}

// Patch a user's department and/or role. `fields` may contain department_id
// and/or role_id; only provided keys are updated. The organization_id filter
// makes it impossible to edit a user in another tenant.
async function updateUser(id, organizationId, fields) {
  const patch = {};
  if ("department_id" in fields) patch.department_id = fields.department_id;
  if ("role_id" in fields) patch.role_id = fields.role_id;
  if (Object.keys(patch).length === 0) return null;
  const { data, error } = await supabase
    .from("users")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select(USER_SELECT)
    .single();
  if (error) throw error;
  return flatten(data);
}

// Soft-delete: mark the account INACTIVE (login is then refused). Keeps the row
// so uploaded documents / metrics retain their provenance.
async function deactivateUser(id, organizationId) {
  const { data, error } = await supabase
    .from("users")
    .update({ status: "INACTIVE" })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id, name, email, status")
    .single();
  if (error) throw error;
  return data;
}

async function verifyEmail(verificationToken) {
  const { data: user, error } = await supabase
    .from("users")
    .select("id, email, email_verification_expires")
    .eq("email_verification_token", verificationToken)
    .single();

  if (error || !user) {
    console.error("[DB] Token not found");
    return null;
  }

  const expiresAt = new Date(user.email_verification_expires);
  if (expiresAt < new Date()) {
    console.error("[DB] Token expired");
    return null;
  }

  const { error: updateError } = await supabase
    .from("users")
    .update({
      email_verified: true,
      email_verification_token: null,
      email_verification_expires: null,
    })
    .eq("id", user.id);

  if (updateError) throw updateError;
  return user;
}

async function findByVerificationToken(token) {
  const { data, error } = await supabase
    .from("users")
    .select("id, name, email")
    .eq("email_verification_token", token)
    .single();
  if (error) return null;
  return data;
}

async function updateFailedLoginAttempts(userId, attempts, lockedUntil) {
  const { error } = await supabase
    .from("users")
    .update({ failed_login_attempts: attempts, locked_until: lockedUntil })
    .eq("id", userId);
  if (error) throw error;
}

// Replace a user's email-verification token + expiry (used to re-issue a fresh
// verification link when an unverified user logs in again).
async function setVerificationToken(userId, token, expires) {
  const { error } = await supabase
    .from("users")
    .update({ email_verification_token: token, email_verification_expires: expires })
    .eq("id", userId);
  if (error) throw error;
}

module.exports = {
  findByEmail,
  findById,
  createUser,
  verifyEmail,
  findByVerificationToken,
  updateFailedLoginAttempts,
  setVerificationToken,
  listUsers,
  updateUser,
  deactivateUser,
};
