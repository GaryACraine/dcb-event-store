---
"@dcb-es/event-store-web": minor
"@dcb-es/event-store-express": minor
---

Add `@dcb-es/event-store-web` and `@dcb-es/event-store-express` packages. The web package provides framework-agnostic RFC 9457 problem details mapping (`toProblemDetails`) and web-specific error classes (`StaleETagError`, `MissingETagError`). The Express package provides `problemDetailsMiddleware` that converts any thrown error into a structured `application/problem+json` response.
