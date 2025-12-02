# SyncGuard — Distributed Lock Library

TypeScript locks for Redis, PostgreSQL, and Firestore.

Docs:

- Specs in `docs/specs/` (start with `interface.md`, then backend deltas, ADRs in `docs/adr/000-template` and `003`–`016`) — see `docs/specs/README.md`
- VitePress site: <https://kriasoft.com/syncguard/>

Commands:

```bash
bun run build      # build dist/
bun run typecheck  # type check
bun run format     # prettier
bun run dev        # watch mode
```

Architecture:

- Core API and types → `docs/specs/interface.md`
- Project layout: `index.ts` (public API), `common/` (shared utilities), `redis/`, `postgres/`, `firestore/` (backends; each has README), `docs/` (specs + ADRs)

Implementation guardrails:

- Follow `docs/specs/interface.md` plus backend specs (`redis-backend.md`, `postgres-backend.md`, `firestore-backend.md`)
- Backend specs restate inherited requirements (ADR-012) and add storage schema, atomicity, error mapping, TTL, and perf notes
- Atomic mutations; TOCTOU-safe release/extend; key- and lockId-based `lookup()`; reuse `common/time-predicates.ts:isLive`

Principles:

- Predictable, composable APIs; smallest practical surface
- Correctness and safety over micro-optimizations; testability first
- Record decisions as ADRs while working, not after

Module exports:

- `syncguard` main types/utilities; subpaths: `syncguard/redis`, `syncguard/postgres`, `syncguard/firestore`, `syncguard/common` (ESM with d.ts)

Testing:

- Unit: `bun run test:unit`
- Build/typecheck: `bun run build && bun run typecheck`
- Integration: `bun run test:integration` (needs Redis 6379, Postgres 5432, Firestore emulator 8080)
- Performance: `bun run test:performance` (optional)

Code standards:

- Functional style; strict TypeScript (ESNext, `noUncheckedIndexedAccess`)
- Prettier formatting; SPDX headers required
- Named exports; tree-shakable
- Errors: public API throws `LockError`; manual ops return `LockResult`; include key/lockId in messages
- Peer deps optional; JSDoc on public APIs
