// src/routes/documentRoutes.js
//
// Documents the user can access + sharing. Mount in server.js:
//   app.use("/api/documents", documentRoutes);
//
//   GET  /api/documents             any member -> docs they can access
//   POST /api/documents/:id/share   ASSIGN_DOCUMENTS -> grant ROLE/DEPT/USER access

const express = require("express");
const fetch = require("node-fetch");

const requireAuth = require("../middleware/requireAuth");
const requirePermission = require("../middleware/requirePermission");
const AppError = require("../utils/AppError");
const {
  listAccessibleDocuments,
  findDocumentById,
  grantAccess,
  deleteDocument,
} = require("../models/documentModel");
const { deleteDocument: deleteDocumentMetrics } = require("../models/metricsModel");
const { findById } = require("../models/userModel");
const { findDepartmentById } = require("../models/departmentModel");
const { findAssignableRole } = require("../models/roleModel");
const { logAdminAction } = require("../models/auditModel");

const RAG_URL = process.env.RAG_SERVICE_URL || "http://localhost:8000";

const router = express.Router();
router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const docs = await listAccessibleDocuments(req.user.id, req.user.organization_id);
    return res.json({ documents: docs });
  } catch (err) {
    return next(err);
  }
});

// POST /api/documents/:id/share
//   { access_type: "ROLE"|"DEPARTMENT"|"USER", role_id?|department_id?|user_id?, expires_at? }
router.post("/:id/share", requirePermission("ASSIGN_DOCUMENTS"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const doc = await findDocumentById(req.params.id);
    if (!doc || doc.organization_id !== orgId) {
      throw new AppError("Document not found.", 404);
    }

    const { access_type, role_id, department_id, user_id, expires_at } = req.body;
    if (!["ROLE", "DEPARTMENT", "USER"].includes(access_type)) {
      throw new AppError("access_type must be ROLE, DEPARTMENT or USER.", 400);
    }

    // Validate the target belongs to this org (can't share across tenants).
    if (access_type === "USER") {
      const target = await findById(user_id);
      if (!target || target.organization_id !== orgId) {
        throw new AppError("User not found in your organization.", 400);
      }
    } else if (access_type === "DEPARTMENT") {
      const dept = await findDepartmentById(department_id);
      if (!dept || dept.organization_id !== orgId) {
        throw new AppError("Department not found in your organization.", 400);
      }
    } else if (access_type === "ROLE") {
      const role = await findAssignableRole(orgId, role_id);
      if (!role) throw new AppError("Role not available in your organization.", 400);
    }

    const access = await grantAccess({
      documentId: doc.id,
      accessType: access_type,
      roleId: role_id,
      departmentId: department_id,
      userId: user_id,
      grantedByUserId: req.user.id,
      expiresAt: expires_at,
    });

    await logAdminAction(req.user.id, "document.share", {
      targetType: "document",
      targetId: doc.id,
      meta: { access_type, role_id, department_id, user_id },
    });
    return res.status(201).json({ access });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/documents/:id
// Remove a document EVERYWHERE: the documents row (cascades document_chunks /
// document_tables / document_access in Supabase), the RAG file + vectors, and
// the uploader's dashboard metrics — so the dashboard updates too. Allowed for
// the uploader or an org_admin.
router.delete("/:id", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const doc = await findDocumentById(req.params.id);
    if (!doc || doc.organization_id !== orgId) {
      throw new AppError("Document not found.", 404);
    }
    if (doc.uploaded_by_user_id !== req.user.id && req.user.role !== "org_admin") {
      throw new AppError("You can only remove documents you uploaded.", 403);
    }

    // 1) Dashboard metrics/status for the uploader (updates their dashboard).
    try {
      await deleteDocumentMetrics(doc.uploaded_by_user_id, doc.file_name);
    } catch {
      /* best-effort */
    }

    // 2) The documents row (cascades chunks / tables / access in Supabase).
    await deleteDocument(doc.id, orgId);

    // 3) The on-disk file + Chroma vectors in the RAG service (best-effort).
    try {
      await fetch(`${RAG_URL}/documents/${encodeURIComponent(doc.file_name)}`, {
        method: "DELETE",
      });
    } catch {
      /* RAG down — DB already cleaned */
    }

    await logAdminAction(req.user.id, "document.delete", {
      targetType: "document",
      targetId: doc.id,
      meta: { file_name: doc.file_name },
    });
    return res.json({ deleted: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
