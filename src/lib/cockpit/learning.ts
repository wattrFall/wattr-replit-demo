export const LEARNING_EVENT_NAMES = [
  "TUTORIAL_STEP_COMPLETED",
  "TUTORIAL_COMPLETED",
  "FACILITY_DRILLDOWN",
  "INCIDENT_REVIEWED",
  "RECOMMENDATION_INSPECTED",
  "WHAT_IF_USED",
  "SAFETY_RESULT",
  "DECISION_RECORDED",
  "ASSISTANT_USED",
  "AUDIT_RECONSTRUCTED",
  "ENGINEERING_TOOL_USED",
  "SCENARIO_COMPLETED",
] as const;

export type LearningEventName = typeof LEARNING_EVENT_NAMES[number];
export type LearningProperties = Record<string, string | number | boolean | null>;
export type LearningErrorCategory =
  | "APPLICATION_FAULT"
  | "SIMULATION_INVARIANT_FAILURE"
  | "PERMISSION_FAILURE"
  | "EXTERNAL_SERVICE_UNAVAILABLE";
export type LearningSurface =
  | "PORTFOLIO" | "TUTORIAL" | "OPERATIONS" | "FORECAST" | "RECOMMENDATIONS"
  | "ASK_WATTR" | "ENGINEERING" | "MODEL_STUDIO" | "MODEL_LAB" | "AUDIT"
  | "LEARNING" | "ADMIN";

const sessionStorageKey = "wattr-learning-session";

export function getLearningSessionId() {
  try {
    const existing = window.sessionStorage.getItem(sessionStorageKey);
    if (existing) return existing;
    const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : "00000000-0000-4000-8000-000000000000";
    window.sessionStorage.setItem(sessionStorageKey, id);
    return id;
  } catch {
    return "00000000-0000-4000-8000-000000000000";
  }
}

export function recordLearningEvent(
  eventName: LearningEventName,
  context: {
    facilityId?: string;
    simulatedAt?: number;
  } = {},
) {
  return fetch("/api/learning/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      eventName,
      facilityId: context.facilityId,
      simulatedAt: context.simulatedAt,
      sessionId: getLearningSessionId(),
    }),
  }).then((response) => response.ok).catch(() => false);
}

export function learningSurfaceForPath(path: string): LearningSurface {
  if (path === "/portfolio") return "PORTFOLIO";
  if (path === "/tutorial") return "TUTORIAL";
  if (path === "/learning") return "LEARNING";
  if (path === "/admin") return "ADMIN";
  if (path.includes("/ask-wattr")) return "ASK_WATTR";
  if (path.includes("/recommendations")) return "RECOMMENDATIONS";
  if (path.includes("/forecast")) return "FORECAST";
  if (path.includes("/engineering")) return "ENGINEERING";
  if (path.includes("/model-studio")) return "MODEL_STUDIO";
  if (path.includes("/model-lab")) return "MODEL_LAB";
  if (path.includes("/audit")) return "AUDIT";
  return "OPERATIONS";
}

export function reportLearningError(
  category: LearningErrorCategory,
  code: string,
  context: { facilityId?: string; route?: string } = {},
) {
  void fetch("/api/learning/errors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      category,
      code,
      facilityId: context.facilityId,
      surface: learningSurfaceForPath(context.route ?? window.location.pathname),
    }),
  }).catch(() => {});
}