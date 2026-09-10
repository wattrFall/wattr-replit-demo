---
name: Ephemeral test ports
description: Avoid nondeterministic collisions when one test process starts multiple local servers.
---

Calling an available-port helper only discovers a free port; it does not reserve that port. When a test allocates multiple ports before either server binds, explicitly reject duplicate results or bind the first server before discovering the next.

**Why:** Two listeners can receive the same unreserved port and fail nondeterministically even when isolated runs pass.

**How to apply:** In any integration test that owns multiple listeners, guarantee unique ports before spawning them and keep startup health checks free of unguarded follow-up requests.