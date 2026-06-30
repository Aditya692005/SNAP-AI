// Department-specific metric catalog — the source of truth for what the
// dashboard can display. Extraction (RAG service) populates these; users choose
// which to show. Keep metric keys in sync with rag_service/main.py METRIC_CATALOG.

export const DEPARTMENTS = [
  { id: "finance", label: "Finance", color: "#8b5cf6", icon: "💰" },
  { id: "sales", label: "Sales", color: "#22d3ee", icon: "🛒" },
  { id: "marketing", label: "Marketing", color: "#ec4899", icon: "📣" },
  { id: "hr", label: "Human Resources", color: "#34d399", icon: "👥" },
  { id: "operations", label: "Operations", color: "#f59e0b", icon: "⚙️" },
];

// kind drives value formatting: "currency" | "number" | "percent".
export const METRIC_CATALOG = [
  // Finance
  { key: "revenue", label: "Revenue", department: "finance", kind: "currency" },
  { key: "profit", label: "Profit", department: "finance", kind: "currency" },
  { key: "expenditure", label: "Expenditure", department: "finance", kind: "currency" },
  { key: "cash_flow", label: "Cash Flow", department: "finance", kind: "currency" },
  // Sales
  { key: "sales", label: "Sales", department: "sales", kind: "currency" },
  { key: "units_sold", label: "Units Sold", department: "sales", kind: "number" },
  { key: "new_customers", label: "New Customers", department: "sales", kind: "number" },
  { key: "average_deal_size", label: "Avg Deal Size", department: "sales", kind: "currency" },
  // Marketing
  { key: "marketing_spend", label: "Marketing Spend", department: "marketing", kind: "currency" },
  { key: "leads", label: "Leads", department: "marketing", kind: "number" },
  { key: "conversion_rate", label: "Conversion Rate", department: "marketing", kind: "percent" },
  { key: "website_traffic", label: "Website Traffic", department: "marketing", kind: "number" },
  // Human Resources
  { key: "headcount", label: "Headcount", department: "hr", kind: "number" },
  { key: "attrition_rate", label: "Attrition Rate", department: "hr", kind: "percent" },
  { key: "new_hires", label: "New Hires", department: "hr", kind: "number" },
  { key: "training_cost", label: "Training Cost", department: "hr", kind: "currency" },
  // Operations
  { key: "production_output", label: "Production Output", department: "operations", kind: "number" },
  { key: "defect_rate", label: "Defect Rate", department: "operations", kind: "percent" },
  { key: "inventory", label: "Inventory", department: "operations", kind: "number" },
  { key: "on_time_delivery", label: "On-Time Delivery", department: "operations", kind: "percent" },
];

// Metrics shown by default before the user customizes (must match the backend's
// DEFAULT_VISIBLE in dashboardRoutes.js).
export const DEFAULT_VISIBLE = new Set(["revenue", "sales", "profit", "expenditure"]);

export const METRIC_BY_KEY = Object.fromEntries(METRIC_CATALOG.map((m) => [m.key, m]));
export const DEPT_BY_ID = Object.fromEntries(DEPARTMENTS.map((d) => [d.id, d]));

export function metricLabel(key) {
  return METRIC_BY_KEY[key]?.label || key;
}

export function metricColor(key) {
  const dept = METRIC_BY_KEY[key]?.department;
  return DEPT_BY_ID[dept]?.color || "#8b5cf6";
}

// Resolve whether a metric should display, given the user's sparse prefs map.
export function isMetricVisible(key, prefs) {
  if (prefs && key in prefs) return prefs[key];
  return DEFAULT_VISIBLE.has(key);
}
