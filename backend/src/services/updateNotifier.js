// src/services/updateNotifier.js
//
// Thin, BEST-EFFORT layer the route handlers call to emit "Updates" feed rows
// when something notification-worthy happens (a document shared/retracted, a
// metric added to a shared board). Every function swallows its own errors: a
// notification failing must never break the action that triggered it. The
// caller can `await` these or fire-and-forget them.

const {
  createUpdatesForUsers,
  recipientsForShareTarget,
  recipientsForDepartment,
  recipientsForOrganization,
} = require("../models/updateModel");
const { findById } = require("../models/userModel");
const { findDepartmentById } = require("../models/departmentModel");

async function actorName(actorId) {
  try {
    const u = await findById(actorId);
    return u?.name || "Someone";
  } catch {
    return "Someone";
  }
}

const docLabel = (doc) => doc?.title || doc?.file_name || "a document";

// A document was shared at one tier. Notifies whoever the tier reaches.
async function notifyDocumentShared({ organizationId, actorId, doc, accessType, userId, departmentId, roleId }) {
  try {
    const recipients = await recipientsForShareTarget(
      organizationId,
      { accessType, userId, departmentId, roleId },
      { excludeUserId: actorId }
    );
    if (recipients.length === 0) return;
    const who = await actorName(actorId);
    await createUpdatesForUsers(recipients, {
      organizationId,
      type: "document_shared",
      title: "New document shared",
      body: `${who} shared "${docLabel(doc)}" with you.`,
      documentId: doc?.id ?? null,
      metadata: { file_name: doc?.file_name ?? null, access_type: accessType },
    });
  } catch {
    /* best-effort */
  }
}

// A set of users lost access to a document (one grant revoked, or the whole
// document removed). `recipients` is the already-resolved user-id list.
async function notifyDocumentRetracted({ organizationId, actorId, doc, recipients, removed = false }) {
  try {
    const ids = (recipients || []).filter((id) => id && id !== actorId);
    if (ids.length === 0) return;
    await createUpdatesForUsers(ids, {
      organizationId,
      type: "document_retracted",
      title: removed ? "Document removed" : "Document access removed",
      body: removed
        ? `"${docLabel(doc)}" was removed and is no longer available.`
        : `Your access to "${docLabel(doc)}" was removed.`,
      // No document_id: the row is gone / no longer readable, so it isn't clickable.
      metadata: { file_name: doc?.file_name ?? null },
    });
  } catch {
    /* best-effort */
  }
}

// A metric was added to a shared board (department or organization). Notifies
// the board's audience (minus the person who added it).
async function notifyMetricAdded({ organizationId, actorId, scope, departmentId, label }) {
  try {
    let recipients = [];
    let where = "a shared";
    if (scope === "department" && departmentId) {
      recipients = await recipientsForDepartment(organizationId, departmentId, { excludeUserId: actorId });
      const dept = await findDepartmentById(departmentId).catch(() => null);
      where = dept?.name ? `the ${dept.name}` : "your department";
    } else if (scope === "organization") {
      recipients = await recipientsForOrganization(organizationId, { excludeUserId: actorId });
      where = "the organization";
    }
    if (recipients.length === 0) return;
    const who = await actorName(actorId);
    await createUpdatesForUsers(recipients, {
      organizationId,
      type: "metric_added",
      title: "New metric added",
      body: `${who} added the "${label}" metric to ${where} dashboard.`,
      metadata: { label, scope },
    });
  } catch {
    /* best-effort */
  }
}

module.exports = {
  notifyDocumentShared,
  notifyDocumentRetracted,
  notifyMetricAdded,
};
