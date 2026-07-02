// src/models/documentModel.js
//
// The `documents` registry + `document_access` (sharing). The RAG service writes
// document_chunks/document_tables keyed by document_id; this model owns the
// document row, who can see it, and the accessible-id set used to scope search.

const supabase = require("../../supabase/supabase");

async function createDocument(organizationId, userId, { title, fileName, storagePath, mimeType, fileSize }) {
  const { data, error } = await supabase
    .from("documents")
    .insert({
      organization_id: organizationId,
      uploaded_by_user_id: userId,
      title: title || fileName,
      file_name: fileName,
      storage_path: storagePath,
      mime_type: mimeType ?? null,
      file_size: fileSize ?? null,
      status: "PROCESSING",
    })
    .select("id, file_name, status")
    .single();
  if (error) throw error;
  return data;
}

async function setDocumentStatus(id, status) {
  const { error } = await supabase.from("documents").update({ status }).eq("id", id);
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
    .select("id, file_name")
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

// Grant access to a document by ROLE / DEPARTMENT / USER.
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
    .select("id, access_type")
    .single();
  if (error) throw error;
  return data;
}

// Every document id the user may see: their own uploads + non-expired
// document_access grants by USER / their DEPARTMENT / their ROLE.
async function accessibleDocumentIds(userId, organizationId) {
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
    const { data: byDept } = await supabase
      .from("document_access")
      .select("document_id")
      .eq("access_type", "DEPARTMENT")
      .eq("department_id", deptId)
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

  return [...ids];
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

async function listAccessibleDocuments(userId, organizationId) {
  const ids = await accessibleDocumentIds(userId, organizationId);
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
  findDocumentById,
  findByFileName,
  deleteDocument,
  deleteAllForUser,
  grantAccess,
  accessibleDocumentIds,
  listAccessibleDocuments,
  listUploadedFileNames,
};
