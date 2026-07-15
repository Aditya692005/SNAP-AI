const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

function authHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${localStorage.getItem("token")}`,
  };
}

export const authService = {
  // Check whether the email's domain already has an organization. When it
  // doesn't, this signup creates the org and the form collects its details.
  async checkOrgStatus(email) {
    const response = await fetch(
      `${API_BASE_URL}/api/auth/org-status?email=${encodeURIComponent(email)}`,
    );
    if (!response.ok) return { valid: false };
    return response.json();
  },

  // `org` (optional) = { name, bio, industry } - only used when the email's
  // domain is new, in which case this user becomes the org_admin.
  async signup(name, email, password, org) {
    const body = { name, email, password };
    if (org) {
      body.organizationName = org.name;
      body.organizationBio = org.bio;
      body.organizationIndustry = org.industry;
      body.organizationCountry = org.country;
      body.organizationSubscriptionPlan = org.subscriptionPlan;
    }
    const response = await fetch(`${API_BASE_URL}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || "Signup failed");
    }

    const data = await response.json();
    // Don't set token yet - user needs to verify email first
    localStorage.setItem("pendingEmail", email);
    return data;
  },

  async checkEmailExists(email) {
    const response = await fetch(
      `${API_BASE_URL}/api/auth/email-exists?email=${encodeURIComponent(email)}`,
    );
    if (!response.ok) throw new Error("Could not check email");
    return (await response.json()).exists || false;
  },

  async getDepartments() {
    const response = await fetch(`${API_BASE_URL}/api/auth/departments`);
    if (!response.ok) throw new Error("Could not load departments");
    return (await response.json()).departments || [];
  },

  async login(email, password) {
    const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || "Login failed");
    }

    const data = await response.json();
    localStorage.setItem("token", data.token);
    localStorage.setItem("user", JSON.stringify(data.user));
    localStorage.removeItem("pendingEmail");
    return data;
  },

  async verifyEmail(token) {
    const response = await fetch(`${API_BASE_URL}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || "Verification failed");
    }

    return await response.json();
  },

  // Forgot password: request a reset link by email (always succeeds generically).
  async forgotPassword(email) {
    const response = await fetch(`${API_BASE_URL}/api/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "Request failed");
    return data;
  },

  // Reset password via the emailed OTP (new password, no current password).
  async resetPassword(email, otp, password) {
    const response = await fetch(`${API_BASE_URL}/api/auth/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, otp, password }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "Reset failed");
    return data;
  },

  // Invitations (admin-added users)
  async getInviteInfo(token) {
    const res = await fetch(
      `${API_BASE_URL}/api/auth/invite-info?token=${encodeURIComponent(token)}`,
    );
    if (!res.ok) return { valid: false };
    return res.json();
  },
  async acceptInvite(token, password, name) {
    const res = await fetch(`${API_BASE_URL}/api/auth/accept-invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password, name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "Could not accept invite");
    return data;
  },

  // Change password while logged in (requires current password).
  async changePassword(currentPassword, newPassword) {
    const response = await fetch(`${API_BASE_URL}/api/auth/change-password`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(data.message || "Could not change password");
    return data;
  },

  logout() {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    localStorage.removeItem("pendingEmail");
  },

  getToken() {
    return localStorage.getItem("token");
  },

  getUser() {
    const user = localStorage.getItem("user");
    return user ? JSON.parse(user) : null;
  },

  // Re-fetch the current user from the server and refresh the cached copy. The
  // login payload is a snapshot, so if an admin moves the user to another
  // department (or changes their role), the cached department_id/permissions go
  // stale until the next login. Calling this keeps UI gating and the profile in
  // sync without a forced re-login. Returns the fresh user (or the cached one on
  // failure). Includes `department_name` resolved server-side.
  async refreshUser() {
    try {
      const res = await fetch(`${API_BASE_URL}/api/auth/me`, {
        headers: authHeaders(),
      });
      if (!res.ok) return this.getUser();
      const data = await res.json();
      if (data?.user) localStorage.setItem("user", JSON.stringify(data.user));
      return data?.user ?? this.getUser();
    } catch {
      return this.getUser();
    }
  },

  // Self-service profile update (name only — see PATCH /api/auth/me). Writes the
  // fresh user straight into the cache and announces it, because there is no
  // global store: UserMenu keeps its own copy of the user and would otherwise show
  // the old name/initials until it happened to remount. A `storage` event is no
  // help here — the browser only fires that in OTHER tabs.
  async updateProfile(fields) {
    const { user } = await handle(
      await fetch(`${API_BASE_URL}/api/auth/me`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify(fields),
      })
    );
    localStorage.setItem("user", JSON.stringify(user));
    window.dispatchEvent(new Event("snap:user-updated"));
    return user;
  },

  isAuthenticated() {
    return !!this.getToken();
  },

  isAdmin() {
    return this.getUser()?.role === "org_admin";
  },

  // Permission actions granted to the logged-in user (from the login payload).
  getPermissions() {
    return this.getUser()?.permissions || [];
  },

  getDepartmentId() {
    return this.getUser()?.department_id || null;
  },

  // Can the user edit ANY department dashboard? Admins can (any board); a manager
  // can only if they belong to a department (they edit their own team's board).
  // This only gates UI affordances — the server is the source of truth.
  canManageDepartmentDashboards() {
    if (this.isAdmin()) return true;
    return (
      this.getPermissions().includes("MANAGE_DEPARTMENT_DASHBOARD") &&
      !!this.getDepartmentId()
    );
  },

  // Organization dashboard: a single org-wide board. VIEW is admins + managers by
  // default; EDIT (pin/rename/remove) is admins by default. UI gating only — the
  // server is the source of truth.
  canViewOrganizationDashboard() {
    if (this.isAdmin()) return true;
    return this.getPermissions().includes("VIEW_ORGANIZATION_DASHBOARD");
  },

  canManageOrganizationDashboard() {
    if (this.isAdmin()) return true;
    return this.getPermissions().includes("MANAGE_ORGANIZATION_DASHBOARD");
  },
};

async function handle(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message || "Request failed");
    // Machine-readable details (e.g. code "DUPLICATE_FILENAME" + can_overwrite
    // on uploads) so callers can offer a resolution instead of just a message.
    err.code = body.code;
    err.canOverwrite = body.can_overwrite;
    throw err;
  }
  return res.json();
}

// Company-admin (org_admin) operations.
export const adminService = {
  async listUsers() {
    return (
      (
        await handle(
          await fetch(`${API_BASE_URL}/api/admin/users`, {
            headers: authHeaders(),
          }),
        )
      ).users || []
    );
  },
  async updateUser(id, fields) {
    return handle(
      await fetch(`${API_BASE_URL}/api/admin/users/${id}`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify(fields),
      }),
    );
  },
  async deactivateUser(id) {
    return handle(
      await fetch(`${API_BASE_URL}/api/admin/users/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      }),
    );
  },
  async reactivateUser(id) {
    return handle(
      await fetch(`${API_BASE_URL}/api/admin/users/${id}`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ status: "ACTIVE" }),
      }),
    );
  },
  async deleteUser(id) {
    return handle(
      await fetch(`${API_BASE_URL}/api/admin/users/${id}?permanent=1`, {
        method: "DELETE",
        headers: authHeaders(),
      }),
    );
  },
  async listDepartments() {
    return (
      (
        await handle(
          await fetch(`${API_BASE_URL}/api/admin/departments`, {
            headers: authHeaders(),
          }),
        )
      ).departments || []
    );
  },
  async createDepartment(name, description) {
    return handle(
      await fetch(`${API_BASE_URL}/api/admin/departments`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ name, description }),
      }),
    );
  },
  async updateDepartment(id, fields) {
    return handle(
      await fetch(`${API_BASE_URL}/api/admin/departments/${id}`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify(fields),
      }),
    );
  },
  async deleteDepartment(id, opts = {}) {
    // opts: { reassignTo?: uuid, deactivate?: boolean }
    const q = new URLSearchParams();
    if (opts.reassignTo) q.set("reassign_to", opts.reassignTo);
    if (opts.deactivate) q.set("deactivate", "1");
    const qs = q.toString() ? `?${q.toString()}` : "";
    return handle(
      await fetch(`${API_BASE_URL}/api/admin/departments/${id}${qs}`, {
        method: "DELETE",
        headers: authHeaders(),
      }),
    );
  },

  async deleteRole(id) {
    return handle(
      await fetch(`${API_BASE_URL}/api/admin/roles/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      }),
    );
  },

  // Users
  async inviteUser(payload) {
    // { email, name?, role_id, department_id? }
    return handle(
      await fetch(`${API_BASE_URL}/api/admin/users`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(payload),
      }),
    );
  },

  // Roles & permissions
  async listRoles() {
    return (
      (
        await handle(
          await fetch(`${API_BASE_URL}/api/admin/roles`, {
            headers: authHeaders(),
          }),
        )
      ).roles || []
    );
  },
  async listPermissions() {
    return (
      (
        await handle(
          await fetch(`${API_BASE_URL}/api/admin/permissions`, {
            headers: authHeaders(),
          }),
        )
      ).permissions || []
    );
  },
  async createRole(payload) {
    // { name, description?, permissions: [action, ...] }
    return handle(
      await fetch(`${API_BASE_URL}/api/admin/roles`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(payload),
      }),
    );
  },
};

// Documents + tiered sharing (share button shows only for docs you uploaded;
// the backend enforces per-tier permissions).
export const documentService = {
  async list() {
    return (
      (
        await handle(
          await fetch(`${API_BASE_URL}/api/documents`, {
            headers: authHeaders(),
          }),
        )
      ).documents || []
    );
  },
  // { user_id, can: {user, department, organization}, users: [...], departments: [...] }
  async shareTargets() {
    return handle(
      await fetch(`${API_BASE_URL}/api/documents/share-targets`, {
        headers: authHeaders(),
      }),
    );
  },
  // payload: { access_type, user_id?|department_id?, expires_at? }
  async share(documentId, payload) {
    return handle(
      await fetch(`${API_BASE_URL}/api/documents/${documentId}/share`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(payload),
      }),
    );
  },
  async listAccess(documentId) {
    return (
      (
        await handle(
          await fetch(`${API_BASE_URL}/api/documents/${documentId}/access`, {
            headers: authHeaders(),
          }),
        )
      ).access || []
    );
  },
  async revokeAccess(documentId, accessId) {
    return handle(
      await fetch(
        `${API_BASE_URL}/api/documents/${documentId}/access/${accessId}`,
        {
          method: "DELETE",
          headers: authHeaders(),
        },
      ),
    );
  },
  // Upload ONE file into the RAG pipeline (indexes it + creates the documents
  // row). No Content-Type header — the browser sets the multipart boundary.
  // A same-named document rejects with code "DUPLICATE_FILENAME" unless
  // { overwrite: true } confirms updating the existing document in place.
  async upload(file, { overwrite = false } = {}) {
    const form = new FormData();
    form.append("file", file);
    if (overwrite) form.append("overwrite", "true");
    return handle(
      await fetch(`${API_BASE_URL}/api/rag/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
        body: form,
      }),
    );
  },
  // Remove a document everywhere (DB row, RAG vectors/file, dashboard metrics).
  // Allowed for the uploader or an org_admin — the backend enforces it.
  async remove(documentId) {
    return handle(
      await fetch(`${API_BASE_URL}/api/documents/${documentId}`, {
        method: "DELETE",
        headers: authHeaders(),
      }),
    );
  },
};

// Organization details (read for everyone; edit requires MANAGE_ORGANIZATION).
export const organizationService = {
  async get() {
    return (
      await handle(
        await fetch(`${API_BASE_URL}/api/organization`, {
          headers: authHeaders(),
        }),
      )
    ).organization;
  },
  async update(fields) {
    return (
      await handle(
        await fetch(`${API_BASE_URL}/api/organization`, {
          method: "PATCH",
          headers: authHeaders(),
          body: JSON.stringify(fields),
        }),
      )
    ).organization;
  },
};
