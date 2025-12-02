# ADR-009 Retries Live in Helpers, Core Backends are Single-Attempt

**Status:** Accepted
**Date:** 2025-10
**Tags:** api-design, layering, retries

## Problem

Users expect transparent retry on contention, but the initial spec included retry configuration in core constants, creating confusion about where retry logic lives. Backends should stay minimal and composable.

## Decision

- `lock()` helper handles all retry logic and is the primary export
- Backends perform single-attempt operations only—no retry logic
- Split constants: `BACKEND_DEFAULTS` (ttlMs) from `LOCK_DEFAULTS` (retry config)
- Default strategy: exponential backoff with equal jitter (50% randomization)
- Removed `retryAfterMs` field—no backends can provide meaningful hints

## Alternatives (brief)

- Retry in backends — mixed responsibilities, harder to customize
- No retry support — poor DX for common use case

## Impact

- Positive: Clear layering, predictable API, composable, smaller core API
- Negative/Risks: Breaking change—removed `retryAfterMs` from `AcquireResult`

## Links

- Code/Docs: `common/auto-lock.ts`, `common/constants.ts`
- Related ADRs: None
