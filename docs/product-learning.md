# Product learning measurement plan

Wattr collects only sparse workflow outcomes needed to answer four product
questions:

1. Can a user find the authorized facility context and understand an incident?
2. Can an operator inspect a recommendation, use the what-if and Safety Shield
   tools, and make an explicit disposition?
3. Can managers and model administrators identify completion and friction
   without reading individual operational notes?
4. Which structured assistant topics and product surfaces need clarification?

## Vocabulary

`TUTORIAL_STEP_COMPLETED`, `TUTORIAL_COMPLETED`, `FACILITY_DRILLDOWN`,
`INCIDENT_REVIEWED`, `RECOMMENDATION_INSPECTED`, `WHAT_IF_USED`,
`SAFETY_RESULT`, `DECISION_RECORDED`, `ASSISTANT_USED`,
`AUDIT_RECONSTRUCTED`, `ENGINEERING_TOOL_USED`, and `SCENARIO_COMPLETED`
are the complete journey event vocabulary. Each event is deduplicated per user
and workflow key.

Operator test sessions retain start/completion state, scenario completion,
time-to-understanding, error count, a structured abandonment code, and a
structured qualitative clarity code. Contextual feedback is a short sentiment
plus a structured product-friction code attached to the current route and
authorized facility.

Application faults, simulation invariant failures, permission failures, and
unavailable external services are separate error categories. Error records
store a safe code and route, never a stack trace or raw request.

## Privacy and retention

- Records are scoped to the organization and, when relevant, an authorized
  facility, scenario, model version, role, and simulated time.
- Event properties and qualitative feedback are categorical and allowlisted.
  Raw Ask Wattr questions, free-text comments, operator notes, telemetry values,
  stack traces, credentials, and facility context are not accepted.
- No synthetic simulation tick or sensor sample is written to the learning
  tables. The deterministic replay remains the source of simulation state.
- Journey events, test sessions, and feedback expire after 180 days; classified
  errors expire after 90 days. Aggregated outcome views expose counts and
  averages, not comments or individual event payloads.
- Managers can view summaries only for facilities in their current grants;
  organization administrators can view organization-wide summaries.
  Facility users can submit feedback and their own test-session updates, but
  cannot browse organization learning records.