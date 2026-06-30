// src/routes/organizationRoutes.js
//
// Organization details for the logged-in user's org. Mount in server.js:
//   app.use("/api/organization", organizationRoutes);
//
//   GET   /api/organization   any authenticated member -> read org details
//   PATCH /api/organization   MANAGE_ORGANIZATION (org_admin) -> edit name/bio/industry
//
// The first-run onboarding modal uses GET to detect a missing bio and PATCH to
// fill it in.

const express = require("express");

const requireAuth = require("../middleware/requireAuth");
const requirePermission = require("../middleware/requirePermission");
const AppError = require("../utils/AppError");
const { findById, updateOrganization } = require("../models/organizationModel");
const { logAdminAction } = require("../models/auditModel");

const router = express.Router();

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const org = await findById(req.user.organization_id);
    if (!org) throw new AppError("Organization not found.", 404);
    return res.json({ organization: org });
  } catch (err) {
    return next(err);
  }
});

router.patch("/", requireAuth, requirePermission("MANAGE_ORGANIZATION"), async (req, res, next) => {
  try {
    const fields = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) throw new AppError("Organization name is required.", 400);
      fields.name = name;
    }
    if (req.body.description !== undefined) {
      fields.description = String(req.body.description).trim() || null;
    }
    if (req.body.industry !== undefined) {
      fields.industry = String(req.body.industry).trim() || null;
    }
    if (Object.keys(fields).length === 0) {
      throw new AppError("Nothing to update.", 400);
    }

    const org = await updateOrganization(req.user.organization_id, fields);
    await logAdminAction(req.user.id, "organization.update", {
      targetType: "organization",
      targetId: req.user.organization_id,
      meta: fields,
    });
    return res.json({ organization: org });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
