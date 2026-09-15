---
"@dcb-es/event-store-express": patch
---

Add `course-manager-web-api-sliced` example demonstrating vertical slice architecture with bounded contexts, global tag constants, and fully independent Pongo projections (each projection maintains its own private lookup collections and never cross-reads another projection's data).
