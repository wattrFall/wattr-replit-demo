# Wattr Operator Cockpit

An operator-grade synthetic decision cockpit for AI/HPC thermal operations. It connects workload intent, electrical power, heat, cooling response, forecast risk, safety-checked advisory review, and an immutable operator audit record.

The original interactive cooling sandbox remains available at `/demo/sandbox`. All operating values and outcomes are illustrative and must not be presented as measured facility performance or closed-loop control.

## Start coding

```sh
npm ci
npm run dev
```

The development server exposes the React application and authenticated API on port 5000.

## Checks

```sh
npm run check
npm run demo:validate
npm run build
```

## Runtime foundations

- Clerk provides the operator session.
- PostgreSQL persists app-level roles, facility permissions, model versions, preferences, and audit records.
- `database/schema.sql` documents the development schema applied through Replit's managed database workflow.
