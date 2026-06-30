const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

export const authService = {
  async signup(
    name,
    email,
    password,
    role,
    organizationName,
    description,
    industry,
    contactEmail,
    country,
    subscriptionPlan,
  ) {
    const response = await fetch(`${API_BASE_URL}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        email,
        password,
        role,
        organizationName,
        description,
        industry,
        contactEmail,
        country,
        subscriptionPlan,
      }),
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || "Signup failed");
    }

    const data = await response.json();
    localStorage.setItem("pendingEmail", email);
    return data;
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

    const data = await response.json();
    if (data.token) {
      localStorage.setItem("token", data.token);
      localStorage.setItem("user", JSON.stringify(data.user));
    }
    localStorage.removeItem("pendingEmail");

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

  isAuthenticated() {
    return !!this.getToken();
  },
};
