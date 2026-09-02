---
name: Forward migration parity
description: Ensures previously provisioned databases receive the same integrity contract as clean installations.
---

Do not rely on `CREATE TABLE IF NOT EXISTS` from a clean-schema bootstrap to upgrade an existing table. Forward migrations must explicitly alter legacy columns, backfill references, set required nullability, and add checks and foreign keys.

**Why:** PostgreSQL skips the full table definition when the table already exists, which can leave older installations with weaker types and integrity constraints even though new tables were created successfully.

**How to apply:** Migration tests should start from the prior schema and assert exact data types, nullability, checks, and foreign keys—not only table or column presence.