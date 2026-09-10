---
name: Model-bound decisions
description: Integrity rule for versioned facility models, safety evaluations, and historical reconstruction.
---

Every safety evaluation, incident, and audit decision must retain the exact facility-model version and immutable configuration that generated its replay. If the active model changes after a safety pass, approval must be rejected and re-evaluated.

**Why:** A version label without the generating configuration can associate a decision with physics that did not produce it. Publishing or rolling back between safety evaluation and approval otherwise creates a decision-integrity race.

**How to apply:** Thread validated model configuration through every live and historical replay path. Persist it at decision boundaries, reconstruct from the persisted version/config or snapshot, and reset the shared live session immediately after publish or rollback.