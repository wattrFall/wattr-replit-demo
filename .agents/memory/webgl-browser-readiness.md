---
name: WebGL browser readiness
description: Browser test readiness rules for the facility twin and sandbox.
---

For WebGL pages, wait for DOM content and explicit rendered controls rather than Playwright `networkidle`; Three.js can retain a blob URL after all HTTP requests finish. Test servers should serve the built bundle instead of starting Vite watchers.

**Why:** `networkidle` timed out on a healthy rendered twin, and middleware Vite servers could exhaust the workspace file-watcher limit when the preview was already running.

**How to apply:** Keep WebGL readiness assertions semantic (`Synchronized facility twin`, canvas, replay controls, fallback text) and use a static built bundle for `NODE_ENV=test`.