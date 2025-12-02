# ADR-011 Relaxed Atomicity for Diagnostic Lookup

**Status:** Accepted
**Date:** 2025-10
**Tags:** lookup, atomicity, diagnostics

## Problem

interface.md required atomic lookup (`MUST use atomic script/transaction`), but Firestore used non-atomic indexed queries. This created spec contradiction despite lookup being explicitly diagnostic-only—NOT a correctness guard.

## Decision

Relax atomicity requirement to match diagnostic nature:

- **SHOULD be atomic** for multi-key stores (Redis via Lua script)
- **MAY be non-atomic** for indexed stores (Firestore single indexed query)
- Strong warning: lookup is for diagnostics/UI/monitoring ONLY—never gate mutations on it

## Alternatives (brief)

- Require atomicity everywhere — unnecessary overhead for Firestore
- Remove lookup entirely — loses valuable diagnostic capability

## Impact

- Positive: Removes spec contradiction, simplifies Firestore, preserves Redis atomicity
- Negative/Risks: None—no implementation changes needed

## Links

- Code/Docs: `docs/specs/interface.md` (Lookup Operation), backend specs
- Related ADRs: ADR-003 (ownership verification for mutations)
