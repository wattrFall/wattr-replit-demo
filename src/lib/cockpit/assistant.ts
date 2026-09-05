import type { Role } from "@/lib/security/rolePolicy";

export const ASSISTANT_TOOLS = [
  "portfolio_overview",
  "facility_state",
  "incident_context",
  "recommendation",
  "what_if",
  "audit_history",
  "model_state",
] as const;

export type AssistantTool = typeof ASSISTANT_TOOLS[number];

export type AssistantAction = {
  id: string;
  label: string;
  kind: "NAVIGATE" | "FOCUS";
  path: string;
  capability: "view" | "assistant" | "engineer" | "model";
  focus?: {
    assetId?: string;
    floor?: 1 | 2;
    path?: string[];
    incidentId?: string;
    recommendationId?: string;
    simulatedAt?: number;
  };
};

export type AssistantCitation = {
  id: string;
  label: string;
  kind: string;
  facilityId: string;
  scenarioId: string | null;
  simulatedAt: number | null;
  modelVersionId: string;
  provenance: {
    kind: string;
    syntheticStatus: string;
    source: string;
    sourceRevision: string | null;
    generatedAt: string;
  };
  quality: "GOOD" | "DEGRADED" | "UNKNOWN";
  evidence: Record<string, unknown>;
};

export type AssistantResponse = {
  contractVersion: string;
  answer: string;
  role: Role;
  tool: AssistantTool | "refusal";
  interpretedAs: string;
  context: {
    facilityId: string | null;
    scenarioId: string | null;
    simulatedAt: number | null;
    modelVersionId: string | null;
    provenance: AssistantCitation["provenance"] | null;
    quality: "GOOD" | "DEGRADED" | "UNKNOWN";
  };
  confidence: number | null;
  interpretation: {
    source: "provider" | "deterministic";
    limitation: string | null;
  };
  limitations: string[];
  citations: AssistantCitation[];
  actions: AssistantAction[];
};

export function assistantSuggestions(role: Role, facilityName?: string) {
  if (role === "PORTFOLIO_MANAGER") {
    return [
      "Which facilities need attention first?",
      "Rank the authorized facilities by forecast risk.",
      "What is the portfolio-level recommendation status?",
    ];
  }
  if (role === "MODEL_ADMIN") {
    return [
      `What model parameters and constraints are active at ${facilityName ?? "this facility"}?`,
      "Which model versions are available and validated?",
      "Show the facility mappings and their data quality.",
    ];
  }
  if (role === "ENGINEER") {
    return [
      "What is the current thermal risk and what assets are affected?",
      "Trace the likely cause through the thermal path.",
      "What would happen if the advisory were applied?",
    ];
  }
  return [
    "What is the current risk and which assets are affected?",
    "What is the likely cause and recommended next step?",
    "What would happen if we used the recommendation?",
  ];
}