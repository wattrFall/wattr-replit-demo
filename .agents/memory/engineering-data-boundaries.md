---
name: Engineering data and replay boundaries
description: Keep imported geometry, synthetic operating telemetry, and uncalibrated spatial replay claims distinct.
---

Imported engineering geometry and equipment metadata do not make the operating telemetry measured or the spatial thermal model calibrated. Preserve separate provenance for geometry, boundary-condition datasets, initial thermal state, and simulation outputs.

**Why:** The facility-intelligence PRD combines imports and historical replay in one workflow. That can make an imported model or historical CSV appear to validate thermal predictions, although neither supplies calibration evidence. Asset-level power attribution must also come from the physics model, not arbitrary allocation of facility totals.

**How to apply:** Label outputs simulated even for uploaded historical inputs. Disclose missing initial temperatures and any synthetic initial-state assumption. Omit unsupported cooling-energy savings and per-device allocations. Preserve identical boundary inputs and starting state for baseline/candidate comparisons. Keep unsupported IFC geometry explicit rather than replacing it with invented dimensions.