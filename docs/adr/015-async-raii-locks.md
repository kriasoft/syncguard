# ADR-015 Async RAII for Locks

**Status:** Accepted
**Date:** 2025-10
**Tags:** api-design, disposal, typescript

## Problem

Lock management requires cleanup on all code paths. Manual `try/finally` is error-prone. JavaScript's `await using` (AsyncDisposable, Node.js ≥20) provides RAII for automatic cleanup, but integration required design decisions around error handling, signal propagation, and state management.

## Decision

Integrate AsyncDisposable into all `acquire()` results:

- All results implement `Symbol.asyncDispose` for `await using` compatibility
- Two config patterns: backend-level for `await using`, lock-level for `lock()` helper
- Stateless handle design—delegate idempotency to backend
- Handle methods accept optional `AbortSignal` for per-operation cancellation
- `onReleaseError` callback for disposal failures (disposal never throws)
- Manual `release()`/`extend()` throw on system errors (consistent with backend API)

## Alternatives (brief)

- Separate disposable wrapper — extra API surface
- Mutable released flag — race conditions, complexity
- Throw from disposal — violates AsyncDisposable contract

## Impact

- Positive: Correctness guarantee, ergonomic API, error resilience, composable
- Negative/Risks: None—additive to existing API

## Links

- Code/Docs: `common/disposable.ts`, `docs/specs/interface.md` (Resource Management)
- Related ADRs: ADR-016 (disposal timeout)
