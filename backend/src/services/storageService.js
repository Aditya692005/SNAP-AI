// src/services/storageService.js
//
// The ONLY module that knows the Supabase Storage bucket exists. Everything else
// passes around `storage_path` strings read from the documents table.
//
// The bucket is the store of record for the ORIGINAL uploaded bytes. The RAG service
// keeps a local copy, but purely as a disposable cache it can refill from here.

const supabaseAdmin = require("../../supabase/supabaseAdmin");

const BUCKET = process.env.SUPABASE_BUCKET || "documents";

// Object keys are ASCII-safe: a user's file name can contain anything, and `/` in
// particular would silently fork the key into a new folder. The real name is kept in
// documents.file_name (that's what the browser sees on download); this only shapes the
// key. Nothing ever recomputes a key for an existing document — reads go through the
// stored storage_path — so changing this rule cannot orphan objects already uploaded.
function safeName(fileName) {
  return String(fileName || "file")
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200) || "file";
}

// Originals: org-scoped so two organizations uploading the same file name can never
// collide, document-scoped so a re-upload of the same file resolves to the same key and
// overwrites in place (matching how it already reuses the documents row).
function documentKey(organizationId, documentId, fileName) {
  return `${organizationId}/${documentId}/${safeName(fileName)}`;
}

// AI-generated reports. These exist as files before any documents row does (the row is
// only created if the user clicks "Add to AI"), so they get their own prefix. Org-scoped,
// which is what makes it safe to serve one by file name alone.
function generatedKey(organizationId, fileName) {
  return `generated/${organizationId}/${safeName(fileName)}`;
}

async function putObject(key, buffer, contentType) {
  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(key, buffer, { contentType: contentType || "application/octet-stream", upsert: true });
  if (error) throw error;
  return key;
}

// Buffer of the object's bytes. Throws if it isn't there.
async function getObject(key) {
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(key);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

async function objectExists(key) {
  try {
    await getObject(key);
    return true;
  } catch {
    return false;
  }
}

// Removal is best-effort everywhere it's used: the DB row is already gone by then, so a
// failure here leaves an orphaned object, not a broken app.
async function removeObjects(keys) {
  const list = (keys || []).filter(Boolean);
  if (list.length === 0) return 0;
  const { error } = await supabaseAdmin.storage.from(BUCKET).remove(list);
  if (error) throw error;
  return list.length;
}

async function removeObject(key) {
  return removeObjects([key]);
}

// Every object directly under `prefix`. NOT recursive — Supabase's list() returns
// sub-folders as entries with a null id rather than descending into them. That's fine
// for the one caller (the flat `generated/<org>/` prefix); deleting a user's originals
// goes through removeObjects() with exact keys from the documents table instead.
async function removePrefix(prefix) {
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (error) throw error;
  const keys = (data || []).filter((o) => o.id).map((o) => `${prefix}/${o.name}`);
  return removeObjects(keys);
}

module.exports = {
  BUCKET,
  documentKey,
  generatedKey,
  putObject,
  getObject,
  objectExists,
  removeObject,
  removeObjects,
  removePrefix,
};
