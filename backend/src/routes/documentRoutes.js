// src/routes/documentRoutes.js
//
// Documents the user can access + tiered sharing. Mount in server.js:
//   app.use("/api/documents", documentRoutes);
//
//   GET    /api/documents                    any member -> docs they can access
//   GET    /api/documents/share-targets      what the caller may share to (tiers + pick-lists)
//   POST   /api/documents/:id/share          uploader/org_admin -> grant access:
//            USER         needs ASSIGN_DOCUMENTS
//            DEPARTMENT   needs SHARE_DEPARTMENT_DOCUMENTS (non-admins: own dept subtree only)
//            ORGANIZATION needs SHARE_ORGANIZATION_DOCUMENTS
//            ROLE         org_admin only (API-only, kept as-is)
//   GET    /api/documents/:id/access         uploader/org_admin -> who it's shared with
//   DELETE /api/documents/:id/access/:accessId  uploader/org_admin -> revoke a grant
//
// All shared access is read-only by nature (recipients can view/chat over the
// document; only the uploader or an org_admin can delete or re-share it).

const express = require("express");

const { ragFetch } = require("../utils/ragClient");
const requireAuth = require("../middleware/requireAuth");
const AppError = require("../utils/AppError");
const {
  listAccessibleDocuments,
  findDocumentById,
  grantAccess,
  findActiveGrant,
  listDocumentAccess,
  revokeAccess,
  deleteDocument,
} = require("../models/documentModel");
const { deleteDocument: deleteDocumentMetrics } = require("../models/metricsModel");
const { findById, listUsers } = require("../models/userModel");
const {
  findDepartmentById,
  listDepartments,
  departmentSubtreeIds,
} = require("../models/departmentModel");
const { findAssignableRole, listRolesForOrg } = require("../models/roleModel");
const { logAdminAction } = require("../models/auditModel");
const { getObject, removeObject } = require("../services/storageService");
const { canRead, sendBuffer } = require("../services/documentDownload");
const { recipientsForShareTarget } = require("../models/updateModel");
const { notifyDocumentShared, notifyDocumentRetracted } = require("../services/updateNotifier");

// Union of ACTIVE user ids reached by a document's current access grants — used
// to notify everyone who loses access when a share is revoked or the whole
// document is deleted. `accessRows` come from listDocumentAccess (embedded
// user/department/role objects).
async function recipientsForAccessRows(organizationId, accessRows, { excludeUserId } = {}) {
  const ids = new Set();
  for (const a of accessRows || []) {
    const reached = await recipientsForShareTarget(
      organizationId,
      {
        accessType: a.access_type,
        userId: a.user?.id,
        departmentId: a.department?.id,
        roleId: a.role?.id,
      },
      { excludeUserId }
    ).catch(() => []);
    reached.forEach((id) => ids.add(id));
  }
  return [...ids];
}

const router = express.Router();
router.use(requireAuth);

function hasPerm(req, action) {
  return Array.isArray(req.user.permissions) && req.user.permissions.includes(action);
}

// Only the uploader (or an org_admin) may share/inspect/revoke a document.
function canManageDocument(req, doc) {
  return doc.uploaded_by_user_id === req.user.id || req.user.role === "org_admin";
}

router.get("/", async (req, res, next) => {
  try {
    const docs = await listAccessibleDocuments(req.user.id, req.user.organization_id, {
      // Dept-sharers (managers/admins) also see docs shared to sub-departments
      // of the department they govern.
      subtreeDepartments: hasPerm(req, "SHARE_DEPARTMENT_DOCUMENTS"),
    });
    return res.json({ documents: docs });
  } catch (err) {
    return next(err);
  }
});

// GET /api/documents/share-targets
// The tiers this user may share at, plus the pick-lists for them: org users
// (when they can share person-to-person) and the departments they may target
// (own subtree for managers, all departments for org_admins).
router.get("/share-targets", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const isAdmin = req.user.role === "org_admin";
    const can = {
      user: hasPerm(req, "ASSIGN_DOCUMENTS"),
      department:
        hasPerm(req, "SHARE_DEPARTMENT_DOCUMENTS") && (isAdmin || !!req.user.department_id),
      organization: hasPerm(req, "SHARE_ORGANIZATION_DOCUMENTS"),
      // Role sharing ("all managers" / "all employees") is org_admin-only.
      role: isAdmin,
    };

    let users = [];
    if (can.user) {
      users = (await listUsers(orgId))
        .filter((u) => u.status === "ACTIVE" && u.id !== req.user.id)
        .map((u) => ({ id: u.id, name: u.name, email: u.email }));
    }

    let departments = [];
    if (can.department) {
      const all = await listDepartments(orgId);
      if (isAdmin) {
        departments = all.map((d) => ({ id: d.id, name: d.name }));
      } else {
        const subtree = new Set(await departmentSubtreeIds(orgId, req.user.department_id));
        departments = all
          .filter((d) => subtree.has(d.id))
          .map((d) => ({ id: d.id, name: d.name }));
      }
    }

    // Assignable roles for an admin's "share to all managers / all employees"
    // picker. org_admin is excluded — sharing to fellow admins isn't offered.
    let roles = [];
    if (isAdmin) {
      roles = (await listRolesForOrg(orgId))
        .filter((r) => r.name !== "org_admin")
        .map((r) => ({ id: r.id, name: r.name }));
    }

    // is_admin: org_admins may also share/manage documents they didn't upload.
    return res.json({ user_id: req.user.id, is_admin: isAdmin, can, users, departments, roles });
  } catch (err) {
    return next(err);
  }
});

// POST /api/documents/:id/share
//   { access_type: "USER"|"DEPARTMENT"|"ORGANIZATION"|"ROLE",
//     user_id?|department_id?|role_id?, expires_at? }
// expires_at: ISO date in the future for a time-limited share; omit/null for
// a permanent one. Idempotent per target: re-sharing while a grant is active
// returns the existing grant (200) instead of stacking a duplicate.
router.post("/:id/share", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const doc = await findDocumentById(req.params.id);
    if (!doc || doc.organization_id !== orgId) {
      throw new AppError("Document not found.", 404);
    }
    if (!canManageDocument(req, doc)) {
      throw new AppError("You can only share documents you uploaded.", 403);
    }

    const { access_type, role_id, department_id, user_id, expires_at } = req.body;
    if (!["ROLE", "DEPARTMENT", "USER", "ORGANIZATION"].includes(access_type)) {
      throw new AppError("access_type must be USER, DEPARTMENT, ORGANIZATION or ROLE.", 400);
    }

    // Optional expiry: must parse and lie in the future.
    let expiresAt = null;
    if (expires_at != null && expires_at !== "") {
      const d = new Date(expires_at);
      if (Number.isNaN(d.getTime())) throw new AppError("expires_at is not a valid date.", 400);
      if (d <= new Date()) throw new AppError("expires_at must be in the future.", 400);
      expiresAt = d.toISOString();
    }

    // Per-tier authorization + target validation (targets always in this org).
    if (access_type === "USER") {
      if (!hasPerm(req, "ASSIGN_DOCUMENTS")) {
        throw new AppError("You do not have permission to share documents with other users.", 403);
      }
      const target = await findById(user_id);
      if (!target || target.organization_id !== orgId) {
        throw new AppError("User not found in your organization.", 400);
      }
      if (user_id === doc.uploaded_by_user_id) {
        throw new AppError("That user uploaded this document and already has access.", 400);
      }
    } else if (access_type === "DEPARTMENT") {
      if (!hasPerm(req, "SHARE_DEPARTMENT_DOCUMENTS")) {
        throw new AppError("You do not have permission to share documents with a department.", 403);
      }
      const dept = await findDepartmentById(department_id);
      if (!dept || dept.organization_id !== orgId) {
        throw new AppError("Department not found in your organization.", 400);
      }
      // Non-admin dept-sharers (managers) may only target the subtree they govern.
      if (req.user.role !== "org_admin") {
        const subtree = await departmentSubtreeIds(orgId, req.user.department_id);
        if (!subtree.includes(department_id)) {
          throw new AppError(
            "You can only share with your own department or its sub-departments.",
            403
          );
        }
      }
    } else if (access_type === "ORGANIZATION") {
      if (!hasPerm(req, "SHARE_ORGANIZATION_DOCUMENTS")) {
        throw new AppError(
          "You do not have permission to share documents with the whole organization.",
          403
        );
      }
    } else if (access_type === "ROLE") {
      // Legacy tier, intentionally API-only: org_admin can share to a role.
      if (req.user.role !== "org_admin") {
        throw new AppError("Only an organization admin can share documents by role.", 403);
      }
      const role = await findAssignableRole(orgId, role_id);
      if (!role) throw new AppError("Role not available in your organization.", 400);
    }

    // Idempotent: an equivalent still-active grant is returned as-is.
    const existing = await findActiveGrant(doc.id, access_type, {
      roleId: role_id,
      departmentId: department_id,
      userId: user_id,
    });
    if (existing) return res.status(200).json({ access: existing, already_shared: true });

    const access = await grantAccess({
      documentId: doc.id,
      accessType: access_type,
      roleId: role_id,
      departmentId: department_id,
      userId: user_id,
      grantedByUserId: req.user.id,
      expiresAt,
      organizationId: orgId
    });

    await logAdminAction(req.user.id, "document.share", {
      targetType: "document",
      targetId: doc.id,
      meta: { access_type, role_id, department_id, user_id, expires_at: expiresAt },
    });

    // Notify whoever this share reaches (fire-and-forget; never blocks the share).
    notifyDocumentShared({
      organizationId: orgId,
      actorId: req.user.id,
      doc,
      accessType: access_type,
      userId: user_id,
      departmentId: department_id,
      roleId: role_id,
    }).catch(() => {});

    return res.status(201).json({ access });
  } catch (err) {
    return next(err);
  }
});

// GET /api/documents/:id/access — who this document is shared with.
router.get("/:id/access", async (req, res, next) => {
  try {
    const doc = await findDocumentById(req.params.id);
    if (!doc || doc.organization_id !== req.user.organization_id) {
      throw new AppError("Document not found.", 404);
    }
    if (!canManageDocument(req, doc)) {
      throw new AppError("You can only view sharing for documents you uploaded.", 403);
    }
    // Older uploads self-granted the uploader USER access; that's ownership,
    // not a share, so keep it out of the "Shared with" list.
    const access = (await listDocumentAccess(doc.id)).filter(
      (a) => !(a.access_type === "USER" && a.user?.id === doc.uploaded_by_user_id)
    );
    return res.json({ access });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/documents/:id/access/:accessId — revoke one grant.
router.delete("/:id/access/:accessId", async (req, res, next) => {
  try {
    const doc = await findDocumentById(req.params.id);
    if (!doc || doc.organization_id !== req.user.organization_id) {
      throw new AppError("Document not found.", 404);
    }
    if (!canManageDocument(req, doc)) {
      throw new AppError("You can only manage sharing for documents you uploaded.", 403);
    }

    // Resolve who this grant reached BEFORE deleting it, so we can tell them they
    // lost access. Best-effort — a lookup failure must not block the revoke.
    let losing = [];
    try {
      const grant = (await listDocumentAccess(doc.id)).find((a) => a.id === req.params.accessId);
      if (grant) {
        losing = await recipientsForAccessRows(req.user.organization_id, [grant], {
          excludeUserId: req.user.id,
        });
      }
    } catch {
      /* best-effort */
    }

    const removed = await revokeAccess(req.params.accessId, doc.id);
    if (!removed) throw new AppError("Share not found.", 404);

    await logAdminAction(req.user.id, "document.unshare", {
      targetType: "document",
      targetId: doc.id,
      meta: { access_id: req.params.accessId },
    });

    notifyDocumentRetracted({
      organizationId: req.user.organization_id,
      actorId: req.user.id,
      doc,
      recipients: losing,
    }).catch(() => {});

    return res.json({ revoked: true });
  } catch (err) {
    return next(err);
  }
});

// GET /api/documents/:id/download — the document's ORIGINAL bytes.
// The canonical download route: keyed by id, so there is nothing to guess and nothing
// to disambiguate. Prefer it over the filename-keyed /api/rag/download/:filename, which
// exists only because a cited source in the chat gives the client a name, not an id.
router.get("/:id/download", async (req, res, next) => {
  try {
    const doc = await findDocumentById(req.params.id);
    // Wrong org, or shared with someone else: report missing rather than forbidden, so
    // the route can't be used to probe for which documents exist.
    if (!doc || doc.organization_id !== req.user.organization_id || !(await canRead(req, doc.id))) {
      throw new AppError("Document not found.", 404);
    }
    const buf = await getObject(doc.storage_path);
    return sendBuffer(res, buf, doc.file_name, doc.mime_type);
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/documents/:id
// Remove a document EVERYWHERE: the documents row (cascades document_chunks /
// document_tables / document_access in Supabase), the stored original, the RAG
// vectors + cache, and the uploader's dashboard metrics — so the dashboard updates
// too. Allowed for the uploader or an org_admin.
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

    // Everyone who currently has access (plus the uploader, if an admin is doing
    // the removing) should be told the document is gone. Resolve BEFORE deleting
    // the access rows — afterwards there's nothing left to resolve from.
    let losing = [];
    try {
      const access = await listDocumentAccess(doc.id);
      losing = await recipientsForAccessRows(orgId, access, { excludeUserId: req.user.id });
      if (doc.uploaded_by_user_id !== req.user.id) losing.push(doc.uploaded_by_user_id);
    } catch {
      /* best-effort */
    }

    // 1) Dashboard metrics/status for the uploader (updates their dashboard).
    try {
      await deleteDocumentMetrics(doc.uploaded_by_user_id, doc.file_name);
    } catch {
      /* best-effort */
    }

    // 2) The documents row (cascades chunks / tables / access in Supabase).
    await deleteDocument(doc.id, orgId);

    // 3) The original bytes in Storage (best-effort — an orphaned object is invisible
    //    garbage, and the row it belonged to is already gone).
    try {
      await removeObject(doc.storage_path);
    } catch {
      /* orphaned object; DB already cleaned */
    }

    // 4) The RAG service's local cache copy (best-effort).
    try {
      await ragFetch(
        `/documents/${encodeURIComponent(doc.file_name)}?organization_id=${encodeURIComponent(
          orgId
        )}`,
        { method: "DELETE" },
        15000
      );
    } catch {
      /* RAG down — DB and Storage already cleaned */
    }

    await logAdminAction(req.user.id, "document.delete", {
      targetType: "document",
      targetId: doc.id,
      meta: { file_name: doc.file_name },
    });

    notifyDocumentRetracted({
      organizationId: orgId,
      actorId: req.user.id,
      doc,
      recipients: losing,
      removed: true,
    }).catch(() => {});

    return res.json({ deleted: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
