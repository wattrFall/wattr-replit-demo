export const ROLES = ["PORTFOLIO_MANAGER", "OPERATOR", "ENGINEER", "MODEL_ADMIN", "VIEWER"] as const;
export type Role = typeof ROLES[number];
export type Capability = "view" | "operate" | "engineer" | "model" | "assistant";

export const ROLE_CAPABILITIES: Record<Role, Record<Capability, boolean>> = {
  PORTFOLIO_MANAGER: { view: true, operate: false, engineer: false, model: false, assistant: true },
  OPERATOR: { view: true, operate: true, engineer: false, model: false, assistant: true },
  ENGINEER: { view: true, operate: false, engineer: true, model: false, assistant: true },
  MODEL_ADMIN: { view: true, operate: false, engineer: false, model: true, assistant: false },
  VIEWER: { view: true, operate: false, engineer: false, model: false, assistant: false },
};

export function defaultLandingPath(role: Role) {
  if (role === "PORTFOLIO_MANAGER") return "/portfolio";
  if (role === "MODEL_ADMIN") return "/facilities/{facilityId}/model";
  return "/facilities/{facilityId}/operations";
}