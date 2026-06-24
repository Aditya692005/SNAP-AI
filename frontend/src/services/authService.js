const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

function authHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${localStorage.getItem("token")}`,
  };
}

export const authService = {
  async signup(name, email, password, role, departmentId) {
    const response = await fetch(`${API_BASE_URL}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password, role, departmentId }),
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

  isAuthenticated() {
    return !!this.getToken();
  },

  isAdmin() {
    return this.getUser()?.role === "org_admin";
  },
};

async function handle(res) {
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || "Request failed");
  }
  return res.json();
}

// Company-admin (org_admin) operations.
export const adminService = {
  async listUsers() {
    return (await handle(await fetch(`${API_BASE_URL}/api/admin/users`, { headers: authHeaders() }))).users || [];
  },
  async updateUser(id, fields) {
    return handle(
      await fetch(`${API_BASE_URL}/api/admin/users/${id}`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify(fields),
      })
    );
  },
  async deactivateUser(id) {
    return handle(
      await fetch(`${API_BASE_URL}/api/admin/users/${id}`, { method: "DELETE", headers: authHeaders() })
    );
  },
  async listDepartments() {
    return (await handle(await fetch(`${API_BASE_URL}/api/admin/departments`, { headers: authHeaders() }))).departments || [];
  },
  async createDepartment(name, key) {
    return handle(
      await fetch(`${API_BASE_URL}/api/admin/departments`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ name, key }),
      })
    );
  },
  async deleteDepartment(id) {
    return handle(
      await fetch(`${API_BASE_URL}/api/admin/departments/${id}`, { method: "DELETE", headers: authHeaders() })
    );
  },
};
