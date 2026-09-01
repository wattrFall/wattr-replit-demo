---
name: Deterministic replay cadence
description: Why replay inputs are sampled on globally aligned boundaries while physics remains fixed-step.
---

Sample time-varying scenario inputs on globally aligned one-second boundaries, then integrate the physical kernel in its original fixed slices inside each boundary. Never scale the physical timestep to implement replay speed.

**Why:** Different playback speeds must traverse identical input intervals and thermal slices. Aligned batching preserves exact cross-speed state equality while avoiding the cost of rebuilding scenario topology for every sub-second forecast slice.

**How to apply:** Any new scenario input or controller schedule must be a deterministic function of absolute simulated time and use the same boundary alignment in live replay, forecast, server reconstruction, and tests.