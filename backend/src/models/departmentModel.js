// src/models/departmentModel.js
// CRUD for organisational departments.

const supabase = require("../../supabase/supabase");

async function listDepartments() {
  const { data, error } = await supabase
    .from("departments")
    .select("id, key, name")
    .order("name");
  if (error) throw error;
  return data || [];
}

async function findDepartmentById(id) {
  const { data, error } = await supabase
    .from("departments")
    .select("id, key, name")
    .eq("id", id)
    .single();
  if (error) return null;
  return data;
}

async function createDepartment(key, name) {
  const { data, error } = await supabase
    .from("departments")
    .insert({ key, name })
    .select("id, key, name")
    .single();
  if (error) throw error;
  return data;
}

// Number of (active) users currently in a department — used to block deletion
// of a non-empty department.
async function countUsersInDepartment(id) {
  const { count, error } = await supabase
    .from("users")
    .select("id", { count: "exact", head: true })
    .eq("department_id", id)
    .is("deactivated_at", null);
  if (error) throw error;
  return count || 0;
}

async function deleteDepartment(id) {
  const { error } = await supabase.from("departments").delete().eq("id", id);
  if (error) throw error;
}

module.exports = {
  listDepartments,
  findDepartmentById,
  createDepartment,
  countUsersInDepartment,
  deleteDepartment,
};
