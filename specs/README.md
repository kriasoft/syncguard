# SyncGuard Specifications

Technical specifications for SyncGuard's distributed lock system.

## Files

- **[`interface.md`](./interface.md)** - LockBackend interface contract and common requirements
- **[`firestore.md`](./firestore.md)** - Firestore backend implementation
- **[`redis.md`](./redis.md)** - Redis backend implementation

## Quick Reference

| Need                    | File                                      |
| ----------------------- | ----------------------------------------- |
| API contract            | `interface.md`                            |
| Required diagnostic API | `interface.md` → Lookup Operation         |
| Error handling          | `interface.md` → Error Handling Standards |
| Firestore patterns      | `firestore.md`                            |
| Redis Lua scripts       | `redis.md`                                |
| Architectural decisions | `adrs.md`                                 |

## Implementation Checklist

When building a new backend:

1. Implement all core operations including required `lookup()`
2. Use atomic operations for all mutations
3. Follow error classification from `interface.md`
4. Support key-based and lockId-based `lookup()` queries
5. Document storage limits and TTL semantics
6. Use unified `isLive()` predicate from `common/time-predicates.ts`
7. Implement TOCTOU protection for release/extend operations
