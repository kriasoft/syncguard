# ADR-012 Explicit Restatement of Requirements in Backend Specs

**Status:** Accepted
**Date:** 2025-10
**Tags:** documentation, machine-readability, consistency

## Problem

ADR-010 and interface.md established authoritative `expiresAtMs` requirement, but backend specs didn't explicitly restate it as MUST bullets. Agents could miss critical requirements during compliance checks.

## Decision

Backend specifications MUST restate key inherited requirements in operation sections:

- Add explicit MUST bullets to Acquire and Extend sections
- Reference ADRs for rationale to avoid redundant prose
- Backend Delta Pattern guidance in interface.md

## Alternatives (brief)

- Cross-reference only — agents miss requirements, drift risk
- Full duplication — maintenance burden, inconsistency risk

## Impact

- Positive: Machine-parseable, agents verify from backend tables alone, prevents drift
- Negative/Risks: Minor duplication (mitigated by cross-references)

## Links

- Code/Docs: `docs/specs/README.md` (Backend Delta Pattern), backend specs
- Related ADRs: ADR-010 (authoritative expiresAtMs)
