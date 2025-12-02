// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import { FAILURE_REASON } from "./backend-semantics.js";
import { hashKey } from "./crypto.js";
import type {
  BackendCapabilities,
  KeyLookup,
  KeyOp,
  LockBackend,
  LockEvent,
  LockOp,
  OwnershipLookup,
  TelemetryOptions,
} from "./types.js";

/**
 * Wraps a LockBackend with telemetry hooks for observability.
 * Zero-cost abstraction: no performance impact when not used.
 *
 * @param backend - Base backend to instrument
 * @param options - Telemetry configuration with event callback
 * @returns Instrumented backend with same capabilities
 * @see docs/specs/interface.md Usage patterns and examples
 * @see docs/adr/007-opt-in-telemetry.md for opt-in design rationale
 */
export function withTelemetry<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  options: TelemetryOptions,
): LockBackend<C> {
  /**
   * Emits telemetry event, swallowing errors to prevent affecting lock operations.
   * Telemetry failures MUST NOT impact core functionality.
   */
  const emitEvent = (event: LockEvent): void => {
    try {
      options.onEvent(event);
    } catch {
      // Swallow telemetry errors (ADR-007: async isolation requirement)
    }
  };

  /**
   * Determines if raw identifiers should be included in events.
   * Defaults to false for security (redacts keys/lockIds). Supports boolean or predicate.
   */
  const shouldIncludeRaw = (event: LockEvent): boolean => {
    if (typeof options.includeRaw === "function") {
      try {
        return options.includeRaw(event);
      } catch {
        return false; // Fail-safe: redact on predicate errors
      }
    }
    return options.includeRaw ?? false;
  };

  // Lookup helpers for discriminated union overload (KeyLookup | OwnershipLookup)
  const lookupByKey = async (opts: KeyLookup) => {
    const result = await backend.lookup(opts);

    const event: LockEvent = {
      type: "lookup",
      keyHash: hashKey(opts.key),
      result: result !== null ? "ok" : "fail",
    };

    if (shouldIncludeRaw(event)) {
      event.key = opts.key;
    }

    emitEvent(event);
    return result;
  };

  const lookupByLockId = async (opts: OwnershipLookup) => {
    const result = await backend.lookup(opts);

    const event: LockEvent = {
      type: "lookup",
      lockIdHash: hashKey(opts.lockId),
      result: result !== null ? "ok" : "fail",
    };

    if (shouldIncludeRaw(event)) {
      event.lockId = opts.lockId;
    }

    emitEvent(event);
    return result;
  };

  return {
    async acquire(opts: KeyOp & { ttlMs: number }) {
      const result = await backend.acquire(opts);

      const event: LockEvent = {
        type: "acquire",
        keyHash: hashKey(opts.key),
        result: result.ok ? "ok" : "fail",
      };

      if (!result.ok) {
        event.reason = result.reason; // "locked" when key already held
      }

      if (shouldIncludeRaw(event)) {
        event.key = opts.key;
        if (result.ok) {
          event.lockId = result.lockId;
        }
      }

      emitEvent(event);
      return result;
    },

    async release(opts: LockOp) {
      const result = await backend.release(opts);

      const event: LockEvent = {
        type: "release",
        lockIdHash: hashKey(opts.lockId),
        result: result.ok ? "ok" : "fail",
      };

      // Extract internal failure reason metadata (not exposed in public API)
      if (!result.ok) {
        const meta = (result as any)[FAILURE_REASON];
        if (meta?.reason) {
          event.reason = meta.reason; // "not_found" | "fence_mismatch" | etc.
        }
      }

      if (shouldIncludeRaw(event)) {
        event.lockId = opts.lockId;
      }

      emitEvent(event);
      return result;
    },

    async extend(opts: LockOp & { ttlMs: number }) {
      const result = await backend.extend(opts);

      const event: LockEvent = {
        type: "extend",
        lockIdHash: hashKey(opts.lockId),
        result: result.ok ? "ok" : "fail",
      };

      // Extract internal failure reason metadata (not exposed in public API)
      if (!result.ok) {
        const meta = (result as any)[FAILURE_REASON];
        if (meta?.reason) {
          event.reason = meta.reason; // "not_found" | "fence_mismatch" | etc.
        }
      }

      if (shouldIncludeRaw(event)) {
        event.lockId = opts.lockId;
      }

      emitEvent(event);
      return result;
    },

    async isLocked(opts: KeyOp) {
      const result = await backend.isLocked(opts);

      const event: LockEvent = {
        type: "isLocked",
        keyHash: hashKey(opts.key),
        result: result ? "ok" : "fail",
      };

      if (shouldIncludeRaw(event)) {
        event.key = opts.key;
      }

      emitEvent(event);
      return result;
    },

    lookup(opts: KeyLookup | OwnershipLookup): Promise<any> {
      // Dispatch based on discriminated union ("key" vs "lockId" property)
      if ("key" in opts) {
        return lookupByKey(opts);
      } else {
        return lookupByLockId(opts);
      }
    },

    capabilities: backend.capabilities,
  };
}
