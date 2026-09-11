/** Shapes of the records the cockpit reads from the API. */
import type { Role } from "@/lib/security/rolePolicy";
import type { FacilityModelConfig } from "@/lib/cockpit/simulation";

export type Capabilities = { view: boolean; operate: boolean; engineer: boolean; model: boolean; assistant: boolean };
export type Me = { id: string; display_name: string; organization_id: string; role: Role; is_admin: boolean; is_owner: boolean; capabilities: Capabilities; default_path: string; theme: string; tutorial_complete: boolean; tutorial_step: number; tutorial_role: Role | null };
export type Facility = { id: string; name: string; location: string; model_version: string; model_config: FacilityModelConfig; provenance: "SIMULATED"; recommendation_status: "PROPOSED" | "APPROVED" | "REJECTED" | "EXPIRED" | "NONE"; can_view: boolean; can_operate: boolean; can_edit_model: boolean; can_engineer: boolean; can_assistant: boolean };
export type Audit = { id: number; action: string; scenario_id: string; simulated_at: number; model_version: string; payload: Record<string, any>; created_at: string };
export type IncidentSignal = { id: string; assetId: string; metric: string; direction: string };
export type Incident = { id: string; title: string; severity: "WATCH" | "HIGH"; status: "OPEN" | "RESOLVED"; simulated_at: number; affected_assets: string[]; raw_signal_count: number; likely_cause: string; forecast_minutes: number; correlated_signals: IncidentSignal[]; thermal_path: string[]; deduplication_key: string; model_version: string };
export type SafetyEvaluation = {
  id: string;
  outcome: "PASS" | "WARNING" | "BLOCK";
  checks: Array<{ id: string; status: "PASS" | "WARNING" | "BLOCK"; pass: boolean; detail: string; evidence: Record<string, unknown> }>;
  command: { assetId: string; flowPercent: number; durationMinutes: number };
  simulatedAt: number;
  recommendationVersion: number;
  modelVersionId: string;
};
export type WhatIfComparison = {
  simulatedAt: number;
  modelVersionId: string;
  recommendationVersion: number;
  options: Array<{
    id: "inaction" | "recommendation" | "alternative";
    label: string;
    command: { assetId: string; flowPercent: number; durationMinutes: number } | null;
    peakC: number;
    constraintMinutes: number;
    series: Array<{ simulatedAt: number; peakC: number }>;
  }>;
};
export type ModelVersion = { id: string; facility_id: string; status: "DRAFT" | "VALIDATED" | "PUBLISHED" | "ARCHIVED"; config: Record<string, unknown>; published_at: string | null; created_by: string | null; created_at: string };
export type MemberFacility = { facility_id: string; facility_name: string; can_view: boolean; can_operate: boolean; can_edit_model: boolean };
export type Member = { id: string; email: string | null; display_name: string | null; role: Role; is_admin: boolean; is_owner: boolean; facilities: MemberFacility[] };
export type SessionData = { me: Me; facilities: Facility[] };
export type ThemePreference = "light" | "dark" | "system";
export type LearningOutcomesData = {
  scope: string;
  retention: { eventsAndFeedbackDays: number; errorsDays: number };
  journeyEvents: Array<{ event_name: string; count: number; users: number }>;
  operatorSessions: { total: number; completed: number; abandoned: number; avg_time_to_understanding_s: number | null; avg_error_count: number | null };
  safetyOutcomes: Array<{ outcome: string; count: number }>;
  decisionOutcomes: Array<{ outcome: string; count: number }>;
  feedback: { count: number; positive: number; neutral: number; negative: number };
  errors: Array<{ category: string; count: number }>;
  commonAssistantTopics: Array<{ topic: string; count: number }>;
};
