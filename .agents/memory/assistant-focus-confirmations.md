---
name: Assistant focus confirmations
description: Security and state rules for assistant suggestions that visually focus operational context.
---

Assistant focus suggestions must be short-lived, integrity-protected capabilities bound to the authorized facility, exact resource, scenario, model version, and cited simulation time. Confirmation must re-authorize and re-query that same scope. Focus may update shared visual selection and pause at the cited time, but must never become a decision or command.

**Why:** A plain resource ID can be replayed against a different scenario or model, causing the twin to show context that the answer never cited. A visual suggestion also needs an explicit user confirmation boundary.

**How to apply:** Use this rule for assistant-driven asset, floor, path, incident, forecast, or recommendation focus. Render the result through the same shared twin, HUD, graph, and timeline state used by direct selection.