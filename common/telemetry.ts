// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

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
 * Zero-cost abstraction: no performance impact when not used (ADR-007).
 *
 * @param backend - Base backend to instrument
 * @param options - Telemetry configuration with event callback
 * @returns Instrumented backend with same capabilities
 * @see specs/interface.md for usage patterns
 * @see specs/adrs.md ADR-007 for opt-in telemetry decision
 */
export function withTelemetry<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  options: TelemetryOptions,
): LockBackend<C> {
  /**
   * Emits telemetry event, swallowing any errors to prevent affecting lock operations.
   * Event callbacks MUST NOT block or throw - errors are silently ignored.
   */
  const emitEvent = (event: LockEvent): void => {
    try {
      options.onEvent(event);
    } catch {
      // Swallow telemetry errors (ADR-007: async isolation requirement)
    }
  };

  /**
   * Determines if raw identifiers should be included in event.
   * Default: false (redact for security). Can be boolean or predicate function.
   */
  const shouldIncludeRaw = (event: LockEvent): boolean => {
    if (typeof options.includeRaw === "function") {
      try {
        return options.includeRaw(event);
      } catch {
        return false; // Default to redacted on predicate errors
      }
    }
    return options.includeRaw ?? false;
  };

  // Helper functions for lookup overloads
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
        event.reason = (result as { ok: false; reason: "locked" }).reason;
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
      // Type-safe dispatch based on discriminated union
      if ("key" in opts) {
        return lookupByKey(opts);
      } else {
        return lookupByLockId(opts);
      }
    },

    capabilities: backend.capabilities,
  };
}
