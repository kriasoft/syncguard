# ADR-014 Defensive Detection of Duplicate LockId Documents (Firestore)

**Status:** Accepted
**Date:** 2025-10
**Tags:** firestore, defensive-programming, consistency

## Problem

Firestore lacks database-level unique indexes. The library queries by lockId using `.limit(1)`, which returns an arbitrary document when duplicates exist. Bugs, migrations, or manual interventions could create duplicates that go undetected.

## Decision

Add defensive duplicate detection for Firestore lockId queries:

- Remove `.limit(1)` from lockId queries to enable detection
- When `querySnapshot.docs.length > 1`, treat as internal inconsistency
- Log warning with context (not error—defensive measure)
- MAY delete expired duplicates; SHOULD fail-safe on live duplicates
- Applies to release, extend, and lookup operations

## Alternatives (brief)

- Keep .limit(1) — duplicates remain invisible
- Fail hard on duplicates — too aggressive for defensive check

## Impact

- Positive: Catches data inconsistencies, operational visibility, safe cleanup
- Negative/Risks: Negligible—indexed queries are fast, duplicates shouldn't exist

## Links

- Code/Docs: `firestore/operations/*.ts`, `docs/specs/firestore-backend.md`
- Related ADRs: ADR-003 (ownership verification)
