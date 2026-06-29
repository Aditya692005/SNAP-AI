// src/routes/adminRoutes.js
//
// Company-admin (org_admin) endpoints. Mount in server.js:
//   app.use("/api/admin", adminRoutes);
//
// Every route requires a logged-in org_admin and is scoped to that admin's own
// organization (req.user.organization_id). Destructive actions are recorded in
// admin_audit.

const express = require("express");

const requireAuth = require("../middleware/requireAuth");
const requireRole = require("../middleware/requireRole");
const AppError = require("../utils/AppError");
const { ASSIGNABLE_ROLES } = require("../utils/validators");
const { listUsers, updateUser, deactivateUser, findById } = require("../models/userModel");
const { findRoleByName } = require("../models/roleModel");
const {
  listDepartments,
  findDepartmentById,
  createDepartment,
  countUsersInDepartment,
  deleteDepartment,
} = require("../models/departmentModel");
const { logAdminAction } = require("../models/auditModel");

const router = express.Router();
router.use(requireAuth, requireRole("org_admin"));

// ── Users ─────────────────────────────────────────────────────────────────────
router.get("/users", async (req, res, next) => {
  try {
    return res.json({ users: await listUsers(req.user.organization_id) });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/admin/users/:id  { department_id?, role? }
router.patch("/users/:id", async (req, res, next) => {
  try {
    const id = req.params.id; // uuid
    const orgId = req.user.organization_id;
    const { department_id, role } = req.body;
    const fields = {};

    if (role !== undefined) {
      if (!ASSIGNABLE_ROLES.includes(role)) {
        throw new AppError(`Role must be one of: ${ASSIGNABLE_ROLES.join(", ")}.`, 400);
      }
      const roleRow = await findRoleByName(role);
      if (!roleRow) throw new AppError(`Role '${role}' is not configured.`, 400);
      fields.role_id = roleRow.id;
    }
    if (department_id !== undefined && department_id !== null) {
      const dept = await findDepartmentById(department_id);
      if (!dept || dept.organization_id !== orgId) {
        throw new AppError("Department does not exist in your organization.", 400);
      }
      fields.department_id = dept.id;
    } else if (department_id === null) {
      // Explicit unassign.
      fields.department_id = null;
    }
    if (Object.keys(fields).length === 0) {
      throw new AppError("Provide department_id and/or role to update.", 400);
    }

    const updated = await updateUser(id, orgId, fields);
    if (!updated) throw new AppError("User not found.", 404);
    await logAdminAction(req.user.id, "user.update", {
      targetType: "user",
      targetId: id,
      meta: fields,
    });
    return res.json({ user: updated });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/admin/users/:id  (soft delete / deactivate)
router.delete("/users/:id", async (req, res, next) => {
  try {
    const id = req.params.id; // uuid
    const orgId = req.user.organization_id;
    if (id === req.user.id) {
      throw new AppError("You cannot deactivate your own account.", 400);
    }
    const target = await findById(id);
    if (!target || target.organization_id !== orgId) {
      throw new AppError("User not found.", 404);
    }

    const result = await deactivateUser(id, orgId);
    await logAdminAction(req.user.id, "user.deactivate", {
      targetType: "user",
      targetId: id,
      meta: { email: target.email },
    });
    return res.json({ user: result, deactivated: true });
  } catch (err) {
    return next(err);
  }
});

// ── Departments ───────────────────────────────────────────────────────────────
router.get("/departments", async (req, res, next) => {
  try {
    return res.json({ departments: await listDepartments(req.user.organization_id) });
  } catch (err) {
    return next(err);
  }
});

router.post("/departments", async (req, res, next) => {
  try {
    const name = (req.body.name || "").trim();
    const description = (req.body.description || "").trim() || null;
    if (!name) throw new AppError("Department name is required.", 400);

    const dept = await createDepartment(req.user.organization_id, name, description);
    await logAdminAction(req.user.id, "department.create", {
      targetType: "department",
      targetId: dept.id,
      meta: { name },
    });
    return res.status(201).json({ department: dept });
  } catch (err) {
    if (err && err.code === "23505") {
      return next(new AppError("A department with that name already exists.", 409));
    }
    return next(err);
  }
});

router.delete("/departments/:id", async (req, res, next) => {
  try {
    const id = req.params.id; // uuid
    const dept = await findDepartmentById(id);
    if (!dept || dept.organization_id !== req.user.organization_id) {
      throw new AppError("Department not found.", 404);
    }

    const userCount = await countUsersInDepartment(id);
    if (userCount > 0) {
      throw new AppError(
        `Cannot delete: ${userCount} active user(s) are still in this department. Reassign them first.`,
        409
      );
    }

    await deleteDepartment(id);
    await logAdminAction(req.user.id, "department.delete", {
      targetType: "department",
      targetId: id,
      meta: { name: dept.name },
    });
    return res.json({ deleted: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
