# ADR-004 Lexicographic Fence Comparison

**Status:** Accepted
**Date:** 2025-09
**Tags:** fence-tokens, api-design, precision

## Problem

The original fence design claimed tokens were "opaque" while mandating specific formatting and comparison helpers. More critically, the initial 19-digit format created a **precision safety issue**: Lua numbers use IEEE 754 doubles (~53 bits precision), so fence values exceeding 2^53-1 (~9e15) would suffer precision loss, breaking monotonicity guarantees.

## Decision

Fence tokens are **fixed-width 15-digit zero-padded decimal strings with lexicographic ordering**.

- Direct string comparison (`fenceA > fenceB`) replaces helper functions
- 15 digits stays within Lua's 53-bit precision limit (2^53-1 ≈ 9.007e15)
- 10^15 capacity = ~31.7 years at 1M locks/sec
- All backends return identical format for cross-backend consistency

## Alternatives (brief)

- 19-digit format — exceeds Lua precision, breaks monotonicity
- BigInt format — not JSON-safe, poor cross-language support
- Variable-width strings — lexicographic comparison fails ("9" > "10")
- Helper functions — unnecessary complexity when strings work natively

## Impact

- Positive: Simpler API, precision safety, JSON-safe, cross-language compatible
- Negative/Risks: Breaking change for existing fence values (acceptable pre-1.0)

## Links

- Code/Docs: `docs/specs/interface.md` (Fence Token Format), `common/constants.ts`
- Related ADRs: None
