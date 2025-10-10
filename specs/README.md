# SyncGuard Specifications

Technical specifications for SyncGuard's distributed lock system.

## Reading Order

For best understanding, read specifications in this order:

1. **[interface.md](./interface.md)** — Core LockBackend contract, types, and common requirements
2. Backend-specific deltas (extend core contract with implementation details):
   - **[redis-backend.md](./redis-backend.md)** — Redis implementation with Lua scripts
   - **[firestore-backend.md](./firestore-backend.md)** — Firestore implementation with transactions
3. **[adrs.md](./adrs.md)** — Architecture decisions (optional, historical context)

## Quick Reference

| Need                    | File                                             |
| ----------------------- | ------------------------------------------------ |
| API contract            | `interface.md`                                   |
| Required diagnostic API | `interface.md` → Lookup Operation                |
| Error handling          | `interface.md` → Error Handling Standards        |
| Redis patterns          | `redis-backend.md` → Lua scripts, key schema     |
| Firestore patterns      | `firestore-backend.md` → Transactions, documents |
| Architectural decisions | `adrs.md`                                        |

## Implementation Checklist

When building a new backend:

1. Implement all core operations including required `lookup()`
2. Use atomic operations for all mutations
3. Follow error classification from `interface.md`
4. Support key-based and lockId-based `lookup()` queries
5. Document storage limits and TTL semantics
6. Use unified `isLive()` predicate from `common/time-predicates.ts`
7. Implement TOCTOU protection for release/extend operations

## Specification Structure

All specifications use a **normative vs rationale** pattern to reduce cognitive load and improve machine readability:

### Document Pattern

Each major section follows this structure:

```markdown
## Topic

### Requirements

[All MUST/SHOULD/MAY/NEVER statements - pure contract, parseable by agents]

### Rationale & Notes

[Background, design decisions, tradeoffs, operational guidance]
```

### Benefits for AI Agents

- **Reduced cognitive load**: Agents can extract normative contract bits quickly without parsing explanatory text
- **Clear boundaries**: No mixing of requirements and rationale
- **Machine-parseable**: MUST/SHOULD/MAY/NEVER keywords appear only in Requirements sections
- **Better maintainability**: Updates go to the correct section

### Reading Strategies

**For coding agents** (Claude Code, Gemini CLI, Codex CLI):

- Focus on **Requirements** sections for implementation contracts
- Use **Rationale & Notes** sections only when understanding "why" helps solve ambiguity

**For humans**:

- Read both sections together for complete understanding
- Requirements provide the "what", Rationale provides the "why"

## Specification Keywords

- **MUST** — Required for correctness or contract compliance
- **SHOULD** — Strongly recommended unless valid reason to deviate
- **MAY** — Optional, implementation-specific choice
- **NEVER** — Explicitly forbidden (safety or correctness violation)

**Important**: These keywords appear ONLY in Requirements sections, never in Rationale & Notes sections.

## Backend Delta Pattern

Backend specs (`redis-backend.md`, `firestore-backend.md`) do not repeat common requirements. They document:

- Storage schema and key design
- Atomic operation implementation (Lua scripts, transactions)
- Backend-specific error mapping
- Performance characteristics and limits
- TTL/expiration semantics

All other requirements (types, validation, error classification) are inherited from `interface.md`.
