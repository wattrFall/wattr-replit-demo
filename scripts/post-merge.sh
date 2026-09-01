#!/usr/bin/env bash
set -euo pipefail

npm ci --no-audit --no-fund
npm run db:setup
npm run check
npm run build