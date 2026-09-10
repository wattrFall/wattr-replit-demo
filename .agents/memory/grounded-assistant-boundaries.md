---
name: Grounded assistant boundaries
description: Authorization and evidence rules for role-aware operational assistants.
---

An operational assistant must select evidence by authorized facility, scenario, active model version, and requested scenario time. Citations must retain each source record's own metadata rather than inheriting request-level labels. Proposed actions must identify and re-authorize the exact resource they open; omit actions when the destination workspace cannot preserve that identity.

**Why:** A facility-level permission check alone can still produce a misleading answer when an older or future record is relabeled as current, or when a valid link opens a workspace hard-coded to a different record.

**How to apply:** For every new assistant tool, fail closed on unavailable time/model data, preserve source provenance and quality, and verify action targets at execution time using the same facility and role policy as direct navigation.