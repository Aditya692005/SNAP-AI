// src/models/documentModel.js
//
// The `documents` registry + `document_access` (sharing). The RAG service writes
// document_chunks/document_tables keyed by document_id; this model owns the
// document row, who can see it, and the accessible-id set used to scope search.

const supabase = require("../../supabase/supabase");
const { departmentSubtreeIds } = require("./departmentModel");

async function createDocument(organizationId, userId, { title, fileName, storagePath, mimeType, fileSize, contentHash }) {
  const row = {
    organization_id: organizationId,
    uploaded_by_user_id: userId,
    title: title || fileName,
    file_name: fileName,
    storage_path: storagePath,
    mime_type: mimeType ?? null,
    file_size: fileSize ?? null,
    status: "PROCESSING",
  };
  if (contentHash) row.content_hash = contentHash;

  let { data, error } = await supabase
    .from("documents")
    .insert(row)
    .select("id, file_name, status")
    .single();

  // Pre-migration fallback: if the content_hash column isn't there yet, insert
  // without it so uploads keep working.
  if (error && contentHash && error.code === "PGRST204") {
    delete row.content_hash;
    ({ data, error } = await supabase
      .from("documents")
      .insert(row)
      .select("id, file_name, status")
      .single());
  }
  if (error) throw error;
  return data;
}

// Existing document in the org with the same file BYTES (SHA-256), regardless of
// file name. Returns null when none — or before the content_hash column exists.
async function findByContentHash(organizationId, contentHash) {
  const { data, error } = await supabase
    .from("documents")
    .select("id, file_name")
    .eq("organization_id", organizationId)
    .eq("content_hash", contentHash)
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data;
}

async function setDocumentStatus(id, status) {
  const { error } = await supabase.from("documents").update({ status }).eq("id", id);
  if (error) throw error;
}

// Reset an existing documents row for a re-upload of the same file: back to
// PROCESSING with the new file's size/type. The id is kept so the RAG service's
// per-document cleanup replaces the old chunks/tables instead of duplicating.
async function resetDocumentForReupload(id, { mimeType, fileSize, contentHash }) {
  const update = {
    status: "PROCESSING",
    mime_type: mimeType ?? null,
    file_size: fileSize ?? null,
  };
  if (contentHash) update.content_hash = contentHash;
  let { error } = await supabase.from("documents").update(update).eq("id", id);
  // Pre-migration fallback if content_hash column is absent.
  if (error && contentHash && error.code === "PGRST204") {
    delete update.content_hash;
    ({ error } = await supabase.from("documents").update(update).eq("id", id));
  }
  if (error) throw error;
}

async function findDocumentById(id) {
  const { data, error } = await supabase
    .from("documents")
    .select("id, organization_id, file_name, uploaded_by_user_id, title, status, created_at")
    .eq("id", id)
    .single();
  if (error) return null;
  return data;
}

// Most recent document with this file name in the org (maps the frontend's
// `source` filename to a document_id for focused chat).
async function findByFileName(organizationId, fileName) {
  const { data, error } = await supabase
    .from("documents")
    .select("id, file_name, uploaded_by_user_id")
    .eq("organization_id", organizationId)
    .eq("file_name", fileName)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data;
}

async function deleteDocument(id, organizationId) {
  // document_chunks / document_tables / document_access cascade on delete.
  const { error } = await supabase
    .from("documents")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);
  if (error) throw error;
}

// Delete every document this user uploaded (used by "Clear all documents").
async function deleteAllForUser(userId, organizationId) {
  const { error } = await supabase
    .from("documents")
    .delete()
    .eq("organization_id", organizationId)
    .eq("uploaded_by_user_id", userId);
  if (error) throw error;
}

// Grant access to a document by ROLE / DEPARTMENT / USER / ORGANIZATION.
// ORGANIZATION rows carry no target column (all NULL): they mean "every member
// of the document's organization" and are scoped through the documents join.
async function grantAccess({ documentId, accessType, roleId, departmentId, userId, grantedByUserId, expiresAt }) {
  const row = {
    document_id: documentId,
    access_type: accessType,
    role_id: accessType === "ROLE" ? roleId : null,
    department_id: accessType === "DEPARTMENT" ? departmentId : null,
    user_id: accessType === "USER" ? userId : null,
    granted_by_user_id: grantedByUserId,
    expires_at: expiresAt ?? null,
  };
  const { data, error } = await supabase
    .from("document_access")
    .insert(row)
    .select("id, access_type, expires_at")
    .single();
  if (error) throw error;
  return data;
}

// A still-active grant for the same document + target, or null. Used to keep
// sharing idempotent (re-sharing to the same target doesn't stack rows).
async function findActiveGrant(documentId, accessType, { roleId, departmentId, userId } = {}) {
  const notExpired = `expires_at.is.null,expires_at.gt.${new Date().toISOString()}`;
  let query = supabase
    .from("document_access")
    .select("id, access_type, expires_at")
    .eq("document_id", documentId)
    .eq("access_type", accessType)
    .or(notExpired);
  if (accessType === "ROLE") query = query.eq("role_id", roleId);
  else if (accessType === "DEPARTMENT") query = query.eq("department_id", departmentId);
  else if (accessType === "USER") query = query.eq("user_id", userId);
  const { data, error } = await query.limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

// Every document id the user may see: their own uploads + non-expired
// document_access grants by USER / their DEPARTMENT / their ROLE, plus
// ORGANIZATION-wide grants in their org. With subtreeDepartments (callers pass
// it for users holding SHARE_DEPARTMENT_DOCUMENTS, i.e. managers/admins) the
// DEPARTMENT tier also matches grants to any sub-department of the user's own
// department — a manager sees what's shared anywhere in the subtree they govern.
async function accessibleDocumentIds(userId, organizationId, { subtreeDepartments = false } = {}) {
  const { data: u } = await supabase
    .from("users")
    .select("role_id, department_id")
    .eq("id", userId)
    .single();
  const roleId = u?.role_id ?? null;
  const deptId = u?.department_id ?? null;
  const notExpired = `expires_at.is.null,expires_at.gt.${new Date().toISOString()}`;

  const ids = new Set();

  const { data: owned } = await supabase
    .from("documents")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("uploaded_by_user_id", userId);
  (owned || []).forEach((d) => ids.add(d.id));

  const { data: byUser } = await supabase
    .from("document_access")
    .select("document_id")
    .eq("access_type", "USER")
    .eq("user_id", userId)
    .or(notExpired);
  (byUser || []).forEach((a) => ids.add(a.document_id));

  if (deptId) {
    let deptIds = [deptId];
    if (subtreeDepartments) {
      try {
        const subtree = await departmentSubtreeIds(organizationId, deptId);
        if (subtree.length > 0) deptIds = subtree;
      } catch {
        /* fall back to the exact department */
      }
    }
    const { data: byDept } = await supabase
      .from("document_access")
      .select("document_id")
      .eq("access_type", "DEPARTMENT")
      .in("department_id", deptIds)
      .or(notExpired);
    (byDept || []).forEach((a) => ids.add(a.document_id));
  }

  if (roleId) {
    const { data: byRole } = await supabase
      .from("document_access")
      .select("document_id")
      .eq("access_type", "ROLE")
      .eq("role_id", roleId)
      .or(notExpired);
    (byRole || []).forEach((a) => ids.add(a.document_id));
  }

  // Org-wide shares: scoped to this org through the documents join (the grant
  // row itself has no organization column).
  const { data: byOrg } = await supabase
    .from("document_access")
    .select("document_id, documents!inner(organization_id)")
    .eq("access_type", "ORGANIZATION")
    .eq("documents.organization_id", organizationId)
    .or(notExpired);
  (byOrg || []).forEach((a) => ids.add(a.document_id));

  return [...ids];
}

// Who a document is currently shared with, newest first — with the target's
// display name resolved per tier. Two FKs point document_access at users
// (user_id and granted_by_user_id), so the embeds must name the constraint.
async function listDocumentAccess(documentId) {
  const { data, error } = await supabase
    .from("document_access")
    .select(
      "id, access_type, expires_at, created_at, " +
        "user:users!fk_access_user(id, name, email), " +
        "department:departments!fk_access_department(id, name), " +
        "role:roles!fk_access_role(id, name), " +
        "granted_by:users!fk_access_granted_by(id, name)"
    )
    .eq("document_id", documentId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

// Remove one grant. The document_id filter stops a crafted accessId from
// revoking a grant on some other document. Returns true if a row was deleted.
async function revokeAccess(accessId, documentId) {
  const { data, error } = await supabase
    .from("document_access")
    .delete()
    .eq("id", accessId)
    .eq("document_id", documentId)
    .select("id");
  if (error) throw error;
  return (data || []).length > 0;
}

// Distinct file names this user uploaded (drives the dashboard's document list
// + recompute now that the RAG service no longer keeps a Chroma source index).
async function listUploadedFileNames(userId, organizationId) {
  const { data, error } = await supabase
    .from("documents")
    .select("file_name")
    .eq("organization_id", organizationId)
    .eq("uploaded_by_user_id", userId);
  if (error) throw error;
  return [...new Set((data || []).map((d) => d.file_name))];
}

async function listAccessibleDocuments(userId, organizationId, opts = {}) {
  const ids = await accessibleDocumentIds(userId, organizationId, opts);
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from("documents")
    .select("id, title, file_name, status, uploaded_by_user_id, created_at")
    .in("id", ids)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

module.exports = {
  createDocument,
  setDocumentStatus,
  resetDocumentForReupload,
  findDocumentById,
  findByFileName,
  findByContentHash,
  deleteDocument,
  deleteAllForUser,
  grantAccess,
  findActiveGrant,
  accessibleDocumentIds,
  listAccessibleDocuments,
  listDocumentAccess,
  revokeAccess,
  listUploadedFileNames,
};
