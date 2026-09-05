---
name: Forward migration parity
description: Ensures previously provisioned databases receive the same integrity contract as clean installations.
---

Do not rely on `CREATE TABLE IF NOT EXISTS` from a clean-schema bootstrap to upgrade an existing table. Forward migrations must explicitly alter legacy columns, backfill references, set required nullability, and add checks and foreign keys. Once a migration version may have run, never expand that file to deliver additional schema; add a new version instead.

**Why:** PostgreSQL skips the full table definition when the table already exists, and migration runners skip versions already recorded as applied. Either behavior can leave older installations without new integrity or tables even though clean installs pass.

**How to apply:** Migration tests should start from the prior schema and assert exact data types, nullability, checks, and foreign keys—not only table or column presence. Update migration-count and canonical-version fixtures whenever a new version is registered.