# SyncGuard Specifications

Technical specifications for SyncGuard's distributed lock system.

## Reading Order

For best understanding, read specifications in this order:

1. **[interface.md](./interface.md)** — Core LockBackend contract, types, and common requirements
2. Backend-specific deltas (extend core contract with implementation details):
   - **[redis-backend.md](./redis-backend.md)** — Redis implementation with Lua scripts
   - **[postgres-backend.md](./postgres-backend.md)** — PostgreSQL implementation with transactions
   - **[firestore-backend.md](./firestore-backend.md)** — Firestore implementation with transactions
3. **[adrs.md](./adrs.md)** — Architecture decisions (optional, historical context)

## Quick Reference

| Need                    | File                                             |
| ----------------------- | ------------------------------------------------ |
| API contract            | `interface.md`                                   |
| Required diagnostic API | `interface.md` → Lookup Operation                |
| Error handling          | `interface.md` → Error Handling Standards        |
| Redis patterns          | `redis-backend.md` → Lua scripts, key schema     |
| PostgreSQL patterns     | `postgres-backend.md` → Transactions, tables     |
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

## Architecture Decision Records (ADRs)

ADRs document **why** decisions were made, not **how** to implement them. They focus on design rationale, tradeoffs, and alternatives—not implementation details.

### Content Separation

| Content Type                   | Belongs In                  | ADRs contain                     |
| ------------------------------ | --------------------------- | -------------------------------- |
| Requirements (MUST/SHOULD/MAY) | interface.md, backend specs | Rationale only                   |
| Implementation details         | interface.md, backend specs | Cross-references                 |
| **Design decisions**           | **adrs.md**                 | Context, rationale, consequences |

### Key Principle

**ADRs explain WHY. Specifications define WHAT.**

See [adrs.md](./adrs.md) for the complete ADR template, writing guidelines, and examples.

## Backend Delta Pattern

Backend specs (`redis-backend.md`, `postgres-backend.md`, `firestore-backend.md`) extend the core interface specification (`interface.md`) with implementation-specific details. To enhance machine-parseability and prevent agent drift (per ADR-012), backend specs:

**MUST restate** key inherited requirements as explicit MUST/SHOULD bullets in their operation requirement sections, with cross-references to the rationale in `interface.md` and ADRs (e.g., "see ADR-010 for rationale").

**MUST document** backend-specific implementation details:

- Storage schema and key design
- Atomic operation implementation (Lua scripts, transactions)
- Backend-specific error mapping
- Performance characteristics and limits
- TTL/expiration semantics

This pattern ensures agents can verify compliance from backend-specific operation tables alone, without requiring complex cross-referencing during implementation validation.
