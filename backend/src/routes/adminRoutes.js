// src/routes/adminRoutes.js
//
// Company-admin (org_admin) endpoints. Mount in server.js:
//   app.use("/api/admin", adminRoutes);
//
// Every route requires a logged-in org_admin and is scoped to that admin's own
// organization (req.user.organization_id). Destructive actions are recorded in
// admin_audit.

const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const requireAuth = require("../middleware/requireAuth");
const requireRole = require("../middleware/requireRole");
const AppError = require("../utils/AppError");
const { isValidEmail } = require("../utils/validators");
const {
  listUsers,
  updateUser,
  deactivateUser,
  deleteUser,
  findById,
  findByEmail,
  createUser,
} = require("../models/userModel");
const {
  findAssignableRole,
  findRoleById,
  countUsersWithRole,
  deleteRole,
  listRolesForOrg,
  createRole,
  addRolePermissions,
  listPermissions,
} = require("../models/roleModel");
const {
  listDepartments,
  findDepartmentById,
  createDepartment,
  updateDepartment,
  countUsersInDepartment,
  reassignDepartmentUsers,
  deactivateDepartmentUsers,
  deleteDepartment,
} = require("../models/departmentModel");
const { logAdminAction } = require("../models/auditModel");
const { sendInviteEmail, generateVerificationToken } = require("../services/emailService");

const SALT_ROUNDS = 10;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // invites valid for 7 days

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

// POST /api/admin/users   { email, name?, role_id, department_id? }
// Invite a new user: create the account in this org with the chosen role/dept
// and email them an invite link to set their password.
router.post("/users", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const email = String(req.body.email || "").trim().toLowerCase();
    const { role_id, department_id } = req.body;
    const name = String(req.body.name || "").trim();

    if (!isValidEmail(email)) throw new AppError("A valid email is required.", 400);
    if (!role_id) throw new AppError("A role is required.", 400);

    const role = await findAssignableRole(orgId, role_id);
    if (!role) throw new AppError("That role is not available in your organization.", 400);

    let deptId = null;
    if (department_id) {
      const dept = await findDepartmentById(department_id);
      if (!dept || dept.organization_id !== orgId) {
        throw new AppError("Department does not exist in your organization.", 400);
      }
      deptId = dept.id;
    }

    const existing = await findByEmail(email);
    if (existing) throw new AppError("A user with that email already exists.", 409);

    const displayName = name || email.split("@")[0];
    // Random placeholder password; the user sets a real one when accepting.
    const placeholder = crypto.randomBytes(24).toString("hex");
    const passwordHash = await bcrypt.hash(placeholder, SALT_ROUNDS);
    const token = generateVerificationToken();
    const expires = new Date(Date.now() + INVITE_TTL_MS);

    const user = await createUser({
      name: displayName,
      email,
      passwordHash,
      organizationId: orgId,
      roleId: role.id,
      departmentId: deptId,
      verificationToken: token,
      verificationExpires: expires,
    });

    sendInviteEmail(email, displayName, token).catch((e) =>
      console.error(`[ADMIN] ❌ Invite email failed for ${email}:`, e.message)
    );
    await logAdminAction(req.user.id, "user.invite", {
      targetType: "user",
      targetId: user.id,
      meta: { email, role: role.name, department_id: deptId },
    });
    return res.status(201).json({ user });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/admin/users/:id  { department_id?, role_id? }
router.patch("/users/:id", async (req, res, next) => {
  try {
    const id = req.params.id; // uuid
    const orgId = req.user.organization_id;
    const { department_id, role_id, status } = req.body;
    const fields = {};

    if (role_id !== undefined) {
      if (id === req.user.id) {
        throw new AppError("You can't change your own role.", 400);
      }
      const role = await findAssignableRole(orgId, role_id);
      if (!role) throw new AppError("That role is not available in your organization.", 400);
      fields.role_id = role.id;
    }
    if (status !== undefined) {
      if (!["ACTIVE", "INACTIVE"].includes(status)) {
        throw new AppError("status must be ACTIVE or INACTIVE.", 400);
      }
      if (id === req.user.id) {
        throw new AppError("You can't change your own status.", 400);
      }
      fields.status = status;
      // Reactivating fully resets the account: clear any failed-login lockout so
      // they can log straight back in with their existing password.
      if (status === "ACTIVE") {
        fields.failed_login_attempts = 0;
        fields.locked_until = null;
      }
    }
    if (department_id !== undefined && department_id !== null) {
      const dept = await findDepartmentById(department_id);
      if (!dept || dept.organization_id !== orgId) {
        throw new AppError("Department does not exist in your organization.", 400);
      }
      fields.department_id = dept.id;
    } else if (department_id === null) {
      fields.department_id = null; // explicit unassign
    }
    if (Object.keys(fields).length === 0) {
      throw new AppError("Provide department_id, role_id and/or status to update.", 400);
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

// ── Roles & permissions ───────────────────────────────────────────────────────
router.get("/permissions", async (req, res, next) => {
  try {
    return res.json({ permissions: await listPermissions() });
  } catch (err) {
    return next(err);
  }
});

router.get("/roles", async (req, res, next) => {
  try {
    return res.json({ roles: await listRolesForOrg(req.user.organization_id) });
  } catch (err) {
    return next(err);
  }
});

// POST /api/admin/roles  { name, description?, permissions: [action, ...] }
router.post("/roles", async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    const description = String(req.body.description || "").trim() || null;
    const permissions = Array.isArray(req.body.permissions) ? req.body.permissions : [];
    if (!name) throw new AppError("Role name is required.", 400);

    const role = await createRole(req.user.organization_id, name, description, req.user.id);
    await addRolePermissions(role.id, permissions);
    await logAdminAction(req.user.id, "role.create", {
      targetType: "role",
      targetId: role.id,
      meta: { name, permissions },
    });
    return res.status(201).json({ role: { ...role, is_global: false, permissions } });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/admin/roles/:id  (custom org roles only; not while in use)
router.delete("/roles/:id", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const role = await findRoleById(req.params.id);
    if (!role) throw new AppError("Role not found.", 404);
    if (role.organization_id !== orgId) {
      throw new AppError("Built-in roles can't be deleted.", 400);
    }
    const inUse = await countUsersWithRole(role.id);
    if (inUse > 0) {
      throw new AppError(
        `Cannot delete: ${inUse} user(s) still have this role. Reassign them first.`,
        409
      );
    }
    await deleteRole(role.id);
    await logAdminAction(req.user.id, "role.delete", {
      targetType: "role",
      targetId: role.id,
      meta: { name: role.name },
    });
    return res.json({ deleted: true });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/admin/users/:id           -> deactivate (soft, reversible)
// DELETE /api/admin/users/:id?permanent=1 -> remove the account entirely
router.delete("/users/:id", async (req, res, next) => {
  try {
    const id = req.params.id; // uuid
    const orgId = req.user.organization_id;
    const permanent = req.query.permanent === "1" || req.query.permanent === "true";

    if (id === req.user.id) {
      throw new AppError("You cannot remove your own account.", 400);
    }
    const target = await findById(id);
    if (!target || target.organization_id !== orgId) {
      throw new AppError("User not found.", 404);
    }

    if (permanent) {
      try {
        await deleteUser(id, orgId);
      } catch (e) {
        if (e && e.code === "23503") {
          throw new AppError(
            "This user has associated records (documents/activity) and can't be permanently deleted. Deactivate them instead.",
            409
          );
        }
        throw e;
      }
      await logAdminAction(req.user.id, "user.delete", {
        targetType: "user",
        targetId: id,
        meta: { email: target.email },
      });
      return res.json({ deleted: true, removed: true });
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

// PATCH /api/admin/departments/:id  { name?, description? }
router.patch("/departments/:id", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const dept = await findDepartmentById(req.params.id);
    if (!dept || dept.organization_id !== orgId) {
      throw new AppError("Department not found.", 404);
    }
    const fields = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) throw new AppError("Department name can't be empty.", 400);
      fields.name = name;
    }
    if (req.body.description !== undefined) {
      fields.description = String(req.body.description).trim() || null;
    }
    if (Object.keys(fields).length === 0) {
      throw new AppError("Provide name and/or description to update.", 400);
    }

    const updated = await updateDepartment(req.params.id, orgId, fields);
    await logAdminAction(req.user.id, "department.update", {
      targetType: "department",
      targetId: req.params.id,
      meta: fields,
    });
    return res.json({ department: updated });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/admin/departments/:id
//   ?reassign_to=<deptId>  -> move active users there, then delete
//   ?deactivate=1          -> deactivate active users, then delete
//   (neither, with active users) -> 409 asking the admin to choose
router.delete("/departments/:id", async (req, res, next) => {
  try {
    const id = req.params.id; // uuid
    const orgId = req.user.organization_id;
    const dept = await findDepartmentById(id);
    if (!dept || dept.organization_id !== orgId) {
      throw new AppError("Department not found.", 404);
    }

    const userCount = await countUsersInDepartment(id);
    let handled = null;
    if (userCount > 0) {
      const reassignTo = req.query.reassign_to;
      const deactivate = req.query.deactivate === "1" || req.query.deactivate === "true";

      if (reassignTo) {
        const target = await findDepartmentById(reassignTo);
        if (!target || target.organization_id !== orgId || target.id === id) {
          throw new AppError("Invalid target department to reassign users to.", 400);
        }
        await reassignDepartmentUsers(id, target.id);
        handled = { reassigned_to: target.id, count: userCount };
      } else if (deactivate) {
        await deactivateDepartmentUsers(id);
        handled = { deactivated: userCount };
      } else {
        throw new AppError(
          `This department has ${userCount} active user(s). Reassign them to another department or deactivate them first.`,
          409
        );
      }
    }

    await deleteDepartment(id);
    await logAdminAction(req.user.id, "department.delete", {
      targetType: "department",
      targetId: id,
      meta: { name: dept.name, ...(handled || {}) },
    });
    return res.json({ deleted: true, ...(handled || {}) });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
