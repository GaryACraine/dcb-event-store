---
"@dcb-es/event-store-express": minor
---

Add handler model, response helpers, and application factory to `@dcb-es/event-store-express`. The `on()` wrapper adapts async handlers for Express 4/5 with try/catch error forwarding. Response helpers (`OK`, `Created`, `Accepted`, `NoContent`) produce typed HTTP responses. `getApplication` assembles an Express app with JSON parsing, trace-ID middleware, health endpoints (`/health/live`, `/health/ready`), and problem details error handling. `startAPI` provides HTTP server creation with SIGTERM/SIGINT graceful shutdown.
