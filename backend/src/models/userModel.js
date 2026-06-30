const supabase = require("../../supabase/supabase");

const DEFAULT_PERMISSION_DEFINITIONS = [
  { action: "MANAGE_ORGANIZATION", description: "Edit organization details" },
  {
    action: "MANAGE_USERS",
    description: "Create, edit, deactivate and manage users",
  },
  {
    action: "MANAGE_DEPARTMENTS",
    description: "Create, edit and manage departments",
  },
  { action: "MANAGE_ROLES", description: "Create and manage custom roles" },
  {
    action: "ASSIGN_DOCUMENTS",
    description: "Assign document upload tasks to users",
  },
  { action: "UPLOAD_DOCUMENTS", description: "Upload assigned documents" },
  { action: "VIEW_DOCUMENTS", description: "View accessible documents" },
  { action: "USE_AI_ASSISTANT", description: "Access the AI Assistant" },
  {
    action: "VIEW_ORGANIZATION_DASHBOARD",
    description: "View organization wide dashboard",
  },
  {
    action: "MANAGE_ORGANIZATION_DASHBOARD",
    description: "Create and edit organization wide dashboard",
  },
  {
    action: "VIEW_DEPARTMENT_DASHBOARD",
    description: "View department wide dashboard",
  },
  {
    action: "MANAGE_DEPARTMENT_DASHBOARD",
    description: "Create and edit department wide dashboard",
  },
];

async function findByEmail(email) {
  const { data, error } = await supabase
    .from("users")
    .select(
      "id, name, email, password_hash, organization_id, role_id, department_id, email_verified, failed_login_attempts, locked_until, created_at",
    )
    .eq("email", email)
    .single();
  if (error) return null;

  let role = null;
  if (data?.role_id) {
    const { data: roleData, error: roleError } = await supabase
      .from("roles")
      .select("name")
      .eq("id", data.role_id)
      .single();

    if (!roleError && roleData) {
      role = roleData.name;
    }
  }

  return { ...data, role };
}

async function findById(id) {
  const { data, error } = await supabase
    .from("users")
    .select(
      "id, name, email, organization_id, role_id, department_id, email_verified, created_at",
    )
    .eq("id", id)
    .single();
  if (error) return null;

  let role = null;
  if (data?.role_id) {
    const { data: roleData, error: roleError } = await supabase
      .from("roles")
      .select("name")
      .eq("id", data.role_id)
      .single();

    if (!roleError && roleData) {
      role = roleData.name;
    }
  }

  return { ...data, role };
}

async function createOrganization({
  name,
  description = null,
  industry = null,
  contactEmail,
  country,
  subscriptionPlan = "FREE",
  status = "ACTIVE",
}) {
  const { data, error } = await supabase
    .from("organizations")
    .insert([
      {
        name,
        description,
        industry,
        contact_email: contactEmail,
        country,
        subscription_plan: subscriptionPlan,
        status,
      },
    ])
    .select("id, name")
    .single();

  if (error) throw error;
  return data;
}

async function createRole({
  organizationId = null,
  name,
  description = null,
  createdBy = null,
}) {
  const { data, error } = await supabase
    .from("roles")
    .insert([
      {
        organization_id: organizationId,
        name,
        description,
        created_by: createdBy,
      },
    ])
    .select("id, name")
    .single();

  if (error) throw error;
  return data;
}

async function createAdminRoleWithPermissions({
  organizationId = null,
  createdBy = null,
}) {
  const role = await createRole({
    organizationId,
    name: "admin",
    description: "Administrator role with full access",
    createdBy,
  });

  const actionList = DEFAULT_PERMISSION_DEFINITIONS.map((item) => item.action);
  const { data: existingPermissions, error: existingPermissionsError } =
    await supabase
      .from("permissions")
      .select("id, action")
      .in("action", actionList);

  if (existingPermissionsError) throw existingPermissionsError;

  const existingActionSet = new Set(
    (existingPermissions || []).map((permission) => permission.action),
  );
  const missingPermissions = DEFAULT_PERMISSION_DEFINITIONS.filter(
    (permission) => !existingActionSet.has(permission.action),
  );

  let availablePermissions = existingPermissions || [];
  if (missingPermissions.length > 0) {
    const { data: insertedPermissions, error: insertPermissionsError } =
      await supabase
        .from("permissions")
        .insert(missingPermissions)
        .select("id, action");

    if (insertPermissionsError) throw insertPermissionsError;
    availablePermissions = [
      ...availablePermissions,
      ...(insertedPermissions || []),
    ];
  }

  const rolePermissionRows = availablePermissions.map((permission) => ({
    role_id: role.id,
    permission_id: permission.id,
  }));

  if (rolePermissionRows.length > 0) {
    const { error: rolePermissionError } = await supabase
      .from("role_permissions")
      .upsert(rolePermissionRows, { onConflict: "role_id,permission_id" });

    if (rolePermissionError) throw rolePermissionError;
  }

  return role;
}

async function updateRoleCreatedBy(roleId, userId) {
  const { error } = await supabase
    .from("roles")
    .update({ created_by: userId })
    .eq("id", roleId);

  if (error) throw error;
}

async function createDepartment({
  organizationId = null,
  name,
  description = null,
}) {
  const { data, error } = await supabase
    .from("departments")
    .insert([
      {
        organization_id: organizationId,
        name,
        description,
      },
    ])
    .select("id, name")
    .single();

  if (error) throw error;
  return data;
}

async function createUser({
  name,
  email,
  passwordHash,
  verificationToken,
  verificationExpires,
  organizationId = null,
  roleId = null,
  departmentId = null,
}) {
  const userPayload = {
    name,
    email,
    password_hash: passwordHash,
    email_verified: false,
    email_verification_token: verificationToken,
    email_verification_expires: verificationExpires,
  };

  if (organizationId) userPayload.organization_id = organizationId;
  if (roleId) userPayload.role_id = roleId;
  if (departmentId) userPayload.department_id = departmentId;

  const { data, error } = await supabase
    .from("users")
    .insert([userPayload])
    .select(
      "id, name, email, organization_id, role_id, department_id, email_verified",
    )
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

async function updateVerificationToken(userId, token, expiresAt) {
  const { error } = await supabase
    .from("users")
    .update({
      email_verification_token: token,
      email_verification_expires: expiresAt,
    })
    .eq("id", userId);

  if (error) throw error;
}

module.exports = {
  findByEmail,
  findById,
  createOrganization,
  createRole,
  createAdminRoleWithPermissions,
  updateRoleCreatedBy,
  createDepartment,
  createUser,
  verifyEmail,
  findByVerificationToken,
  updateFailedLoginAttempts,
  updateVerificationToken,
};
