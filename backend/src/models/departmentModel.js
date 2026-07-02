// src/models/departmentModel.js
// CRUD for organisational departments. v2 departments are per-organization
// (uuid id, organization_id, name, description) - the old global `key` column
// is gone, so every query is scoped to an organization.

const supabase = require("../../supabase/supabase");

async function listDepartments(organizationId) {
  const { data, error } = await supabase
    .from("departments")
    .select("id, name, description")
    .eq("organization_id", organizationId)
    .order("name");
  if (error) throw error;
  return data || [];
}

async function findDepartmentById(id) {
  const { data, error } = await supabase
    .from("departments")
    .select("id, name, description, organization_id")
    .eq("id", id)
    .single();
  if (error) return null;
  return data;
}

async function createDepartment(organizationId, name, description = null) {
  const { data, error } = await supabase
    .from("departments")
    .insert({ organization_id: organizationId, name, description })
    .select("id, name, description")
    .single();
  if (error) throw error;
  return data;
}

// Edit a department's name/description, scoped to the org so one tenant can't
// edit another's. Only provided keys change.
async function updateDepartment(id, organizationId, fields) {
  const patch = {};
  if ("name" in fields) patch.name = fields.name;
  if ("description" in fields) patch.description = fields.description;
  if (Object.keys(patch).length === 0) return null;
  const { data, error } = await supabase
    .from("departments")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id, name, description")
    .single();
  if (error) throw error;
  return data;
}

// Number of still-active users in a department - used to block deletion of a
// non-empty department.
async function countUsersInDepartment(id) {
  const { count, error } = await supabase
    .from("users")
    .select("id", { count: "exact", head: true })
    .eq("department_id", id)
    .neq("status", "INACTIVE");
  if (error) throw error;
  return count || 0;
}

// Move every user from one department to another (used when deleting a dept).
async function reassignDepartmentUsers(fromDeptId, toDeptId) {
  const { error } = await supabase
    .from("users")
    .update({ department_id: toDeptId })
    .eq("department_id", fromDeptId);
  if (error) throw error;
}

// Deactivate the (still-active) users in a department (the alternative to
// reassigning them when deleting a dept).
async function deactivateDepartmentUsers(deptId) {
  const { error } = await supabase
    .from("users")
    .update({ status: "INACTIVE" })
    .eq("department_id", deptId)
    .neq("status", "INACTIVE");
  if (error) throw error;
}

async function deleteDepartment(id) {
  const { error } = await supabase.from("departments").delete().eq("id", id);
  if (error) throw error;
}

module.exports = {
  listDepartments,
  findDepartmentById,
  createDepartment,
  updateDepartment,
  countUsersInDepartment,
  reassignDepartmentUsers,
  deactivateDepartmentUsers,
  deleteDepartment,
};
