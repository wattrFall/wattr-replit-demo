---
name: Causal variant branching
description: Rules for trustworthy twin forecasts, alternatives, and controller comparisons.
---

Every baseline, recommendation, operator alternative, and controller comparison must branch from the same thermal state, model configuration, replay instant, and deterministic event stream. A cooling command changes the physical integration path for its bounded duration; its response lag begins when that branch command starts, not when the overall scenario starts.

**Why:** Authored summary deltas and alternative labels can look causal while replaying the baseline physics. That breaks trust across forecasts, what-if results, incidents, and Model Lab.

**How to apply:** Run each option through the shared kernel, prove parameter sensitivity and replay equality with golden/property tests, and report unsupported SNN or physical-AI measurements as unavailable rather than estimating them.