# ADR-016 Opt-In Disposal Timeout

**Status:** Accepted
**Date:** 2025-10
**Tags:** disposal, timeout, reliability

## Problem

`Symbol.asyncDispose` calls `release()` without timeout. If backend hangs (network latency, slow queries), disposal blocks indefinitely. Manual `release()` supports `AbortSignal`, but automatic disposal doesn't—inconsistent cancellation behavior.

## Decision

Add **opt-in** `disposeTimeoutMs` configuration:

- Optional field in `BackendConfig` (no default)
- When configured, disposal creates internal `AbortController` with timeout
- Timeout errors flow through `onReleaseError` callback
- Backend-agnostic—applies to Redis, PostgreSQL, Firestore
- Manual `release()` unaffected—uses caller-provided signal

## Alternatives (brief)

- Default timeout (e.g., 5s) — might cause false timeouts
- Global signal configuration — too complex, no per-lock control
- Do nothing — ignores legitimate reliability concerns

## Impact

- Positive: Responsiveness guarantee, observable failures, defense-in-depth
- Negative/Risks: None—opt-in with no default

## Links

- Code/Docs: `common/disposable.ts`, `common/types.ts`
- Related ADRs: ADR-015 (Async RAII)
