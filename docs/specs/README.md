# SyncGuard Specs

Specifications for the distributed lock system. Read in this order:

1. `interface.md` — core LockBackend contract and required diagnostics
2. Backend deltas — `redis-backend.md`, `postgres-backend.md`, `firestore-backend.md`
3. ADRs — `../adr/` for decision history

Quick lookup:

- API contract, errors, lookup requirements → `interface.md`
- Redis/Postgres/Firestore implementation notes → backend files
- Architecture decisions → `../adr/` (000-template, 003-explicit-ownership-verification, 004-lexicographic-fence-comparison, 005-unified-time-tolerance, 006-mandatory-key-truncation, 007-opt-in-telemetry, 008-compile-time-fencing, 009-retries-in-helpers, 010-authoritative-expiresat, 011-relaxed-lookup-atomicity, 012-backend-restatement-pattern, 013-full-storage-key-in-index, 014-firestore-duplicate-detection, 015-async-raii-locks, 016-disposal-timeout)

Developer Notes:

- Requirements live in **Requirements** subsections; rationale stays in **Rationale & Notes**. MUST/SHOULD/MAY/NEVER appear only in Requirements.
- Backend specs restate inherited requirements (ADR-012) and add storage schema, atomicity, error mapping, TTL, and performance notes.
- When implementing a new backend, ensure atomic mutations, TOCTOU protection for release/extend, both key- and lockId-based `lookup()`, and reuse `isLive()` from `common/time-predicates.ts`.

Keywords:

- MUST = required for contract, SHOULD = strong default, MAY = optional, NEVER = forbidden. Use only in Requirements sections.
