# ADR-007 Opt-In Telemetry

**Status:** Accepted
**Date:** 2025-09
**Tags:** telemetry, api-design, performance

## Problem

Original specification mandated telemetry for all operations, requiring backends to compute hashes and emit events even when no consumer existed. This created unnecessary overhead, complicated the API with redaction policies, and made testing difficult due to side effects.

## Decision

Make telemetry **opt-in** via decorator pattern:

- Telemetry OFF by default—backends don't compute hashes or emit events
- `withTelemetry(backend, options)` wraps backends to add observability
- `lookup()` always returns sanitized data; `getByKeyRaw()`/`getByIdRaw()` provide raw access
- Async isolation—event callbacks never block operations or propagate errors

## Alternatives (brief)

- Mandatory telemetry — unnecessary overhead, testing complexity
- Per-operation telemetry flags — API clutter, inconsistent behavior

## Impact

- Positive: Zero-cost abstraction, cleaner separation, better testing, tree-shakable
- Negative/Risks: Breaking change—applications using `onEvent` must wrap backends

## Links

- Code/Docs: `common/telemetry.ts`, `docs/specs/interface.md`
- Related ADRs: None
