// src/services/departmentDashboardAccess.js
//
// Authorization for department dashboards. Two distinct scopes — and note they
// deliberately DIFFER from document sharing:
//
//   • VIEW is downward: an employee sees only their own department's board; a
//     manager additionally sees every descendant (sub-department) board so they
//     have oversight; an org admin sees all boards in the org.
//
//   • EDIT is exact, NOT subtree: a manager edits ONLY the board of the
//     department they belong to. Each sub-department (team) is edited by its own
//     manager — this spreads the editing load instead of piling every child
//     board onto one parent manager. Org admins edit any board.
//
// (Contrast documentRoutes.js, where a manager gets subtree edit/share rights.
// Dashboards are team-owned; documents are manager-curated. Different on
// purpose.)

const { departmentSubtreeIds } = require("../models/departmentModel");

function isAdmin(user) {
  return user?.role === "org_admin";
}

function hasPerm(user, action) {
  return Array.isArray(user?.permissions) && user.permissions.includes(action);
}

// Department ids whose boards `user` may VIEW.
//   admin    → all (caller passes the org's department ids)
//   manager  → own department + descendants (subtree)
//   employee → own department only
// Returns a Set of ids. `allOrgDepartmentIds` is only consulted for admins.
async function viewableDepartmentIds(user, organizationId, allOrgDepartmentIds) {
  if (isAdmin(user)) return new Set(allOrgDepartmentIds || []);
  if (!hasPerm(user, "VIEW_DEPARTMENT_DASHBOARD") || !user.department_id) return new Set();
  if (hasPerm(user, "MANAGE_DEPARTMENT_DASHBOARD")) {
    // Manager: own department and everything beneath it.
    return new Set(await departmentSubtreeIds(organizationId, user.department_id));
  }
  // Employee: exactly their own department.
  return new Set([user.department_id]);
}

// Can `user` VIEW this specific board?
async function canViewDepartmentBoard(user, board) {
  if (!board) return false;
  if (isAdmin(user)) return true;
  if (!hasPerm(user, "VIEW_DEPARTMENT_DASHBOARD") || !user.department_id) return false;
  if (board.department_id === user.department_id) return true;
  if (hasPerm(user, "MANAGE_DEPARTMENT_DASHBOARD")) {
    const subtree = await departmentSubtreeIds(user.organization_id, user.department_id);
    return subtree.includes(board.department_id);
  }
  return false;
}

// Can `user` EDIT this specific board? Admin: any. Manager: only their own
// department's board (exact match — no subtree). Employees never.
function canEditDepartmentBoard(user, board) {
  if (!board) return false;
  if (isAdmin(user)) return true;
  return (
    hasPerm(user, "MANAGE_DEPARTMENT_DASHBOARD") &&
    !!user.department_id &&
    board.department_id === user.department_id
  );
}

// ── Organization dashboard ────────────────────────────────────────────────────
// A single org-wide board (there's one per organization). Flat scope — no subtree
// logic. VIEW is granted to org admins + VIEW_ORGANIZATION_DASHBOARD holders
// (managers by default); EDIT to org admins + MANAGE_ORGANIZATION_DASHBOARD
// holders (admins by default). The board is always the caller's own organization,
// so there's no cross-org target to check here.
function canViewOrganizationBoard(user) {
  return isAdmin(user) || hasPerm(user, "VIEW_ORGANIZATION_DASHBOARD");
}

function canEditOrganizationBoard(user) {
  return isAdmin(user) || hasPerm(user, "MANAGE_ORGANIZATION_DASHBOARD");
}

module.exports = {
  isAdmin,
  hasPerm,
  viewableDepartmentIds,
  canViewDepartmentBoard,
  canEditDepartmentBoard,
  canViewOrganizationBoard,
  canEditOrganizationBoard,
};
