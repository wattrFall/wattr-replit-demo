---
name: Product learning boundaries
description: Privacy, authorization, reliability, and retention rules for operational product-learning signals.
---

Product-learning signals must use structured categorical values rather than free text, derive authoritative outcomes from successful server actions, and scope manager summaries to current facility grants. Learning writes are best-effort and occur outside operational transactions. Collection is sparse and event-based; deterministic replay ticks and telemetry samples are never learning records. Expired records are both excluded from reads and purged on an independent schedule.

**Why:** Operational feedback can otherwise capture sensitive facility context, leak aggregate activity across grants, corrupt outcome counts through client-forged events, roll back real decisions when analytics fail, or retain data beyond its stated lifetime.

**How to apply:** For any new learning signal, classify it as server-authoritative or non-authoritative UX context, add only an allowlisted code, bind it to an authorized facility/model when applicable, contain write failures, add an expiry, and extend privacy/access/deduplication tests.