// src/models/organizationModel.js
// Organizations are derived from the user's email domain at signup. The first
// user of a new domain creates the organization (and becomes its org_admin);
// everyone else on that domain joins the existing one.

const supabase = require("../../supabase/supabase");

// Departments seeded for every brand-new organization. An org_admin can add to
// or remove from this set later in the admin console.
const DEFAULT_DEPARTMENTS = ["Finance", "Sales", "Marketing", "Human Resources", "Operations"];

// Find an organization by email domain. There's no dedicated `domain` column -
// the org's contact_email is the first user's address, so its domain is the
// tenant key. We match any organization whose contact_email ends in "@<domain>".
// Used for corporate domains, where everyone on the domain shares one org.
async function findByDomain(domain) {
  const { data, error } = await supabase
    .from("organizations")
    .select("id, name, industry, contact_email, country")
    .ilike("contact_email", `%@${domain}`)
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data;
}

// Find an organization by the EXACT contact_email. Used for free email
// providers (gmail.com, outlook.com, ...) where the domain is shared by
// unrelated people, so each address is its own single-person organization.
async function findByContactEmail(email) {
  const { data, error } = await supabase
    .from("organizations")
    .select("id, name, industry, contact_email, country")
    .eq("contact_email", email)
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data;
}

// Create an organization for a freshly-seen email domain and seed it with the
// default departments. `contactEmail` carries the domain (see findByDomain).
// name/description(bio)/industry come from the org_admin's signup form.
async function createOrganization({
  name,
  contactEmail,
  country = "Unknown",
  industry = null,
  description = null,
  subscriptionPlan = "FREE",
}) {
  const { data: org, error } = await supabase
    .from("organizations")
    .insert({
      name,
      contact_email: contactEmail,
      country,
      industry,
      description,
      subscription_plan: subscriptionPlan,
    })
    .select("id, name, description, industry, contact_email, country, subscription_plan")
    .single();
  if (error) throw error;

  const rows = DEFAULT_DEPARTMENTS.map((deptName) => ({
    organization_id: org.id,
    name: deptName,
  }));
  const { error: deptErr } = await supabase.from("departments").insert(rows);
  if (deptErr) throw deptErr;

  return org;
}

async function findById(id) {
  const { data, error } = await supabase
    .from("organizations")
    .select("id, name, description, industry, contact_email, country, subscription_plan")
    .eq("id", id)
    .single();
  if (error) return null;
  return data;
}

// Update editable organization details (name, description/bio, industry). Used
// by the first-run onboarding flow and Settings. Only provided keys change.
async function updateOrganization(id, fields) {
  const patch = {};
  if ("name" in fields) patch.name = fields.name;
  if ("description" in fields) patch.description = fields.description;
  if ("industry" in fields) patch.industry = fields.industry;
  if (Object.keys(patch).length === 0) return null;
  const { data, error } = await supabase
    .from("organizations")
    .update(patch)
    .eq("id", id)
    .select("id, name, description, industry, contact_email, country")
    .single();
  if (error) throw error;
  return data;
}

module.exports = {
  findByDomain,
  findByContactEmail,
  createOrganization,
  findById,
  updateOrganization,
  DEFAULT_DEPARTMENTS,
};
