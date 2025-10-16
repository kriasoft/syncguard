// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import {
  type ExtendResult,
  type LockOp,
  LockError,
  makeStorageKey,
  validateLockId,
} from "../../common/backend.js";
import {
  type MutationReason,
  FAILURE_REASON,
} from "../../common/backend-semantics.js";
import { TIME_TOLERANCE_MS } from "../../common/time-predicates.js";
import { checkAborted, mapRedisError } from "../errors.js";
import { EXTEND_SCRIPT } from "../scripts.js";
import type { RedisConfig } from "../types.js";

/** Redis client with eval and optional cached extendLock method */
interface RedisWithCommands {
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
  extendLock?(
    lockIdKey: string,
    lockId: string,
    toleranceMs: string,
    ttlMs: string,
  ): Promise<[number, number] | number>;
}

/**
 * Creates extend operation that atomically renews lock TTL (replaces entirely, not additive).
 * @see specs/redis-backend.md
 */
export function createExtendOperation(
  redis: RedisWithCommands,
  config: RedisConfig,
) {
  return async (opts: LockOp & { ttlMs: number }): Promise<ExtendResult> => {
    try {
      // Pre-dispatch abort check (ioredis does not accept AbortSignal)
      checkAborted(opts.signal);

      validateLockId(opts.lockId);

      if (!Number.isInteger(opts.ttlMs) || opts.ttlMs <= 0) {
        throw new LockError(
          "InvalidArgument",
          "ttlMs must be a positive integer",
        );
      }

      const REDIS_LIMIT_BYTES = 1000;
      const RESERVE_BYTES = 26; // ":id:" (4 bytes) + 22-char lockId

      const lockIdKey = makeStorageKey(
        config.keyPrefix,
        `id:${opts.lockId}`,
        REDIS_LIMIT_BYTES,
        RESERVE_BYTES,
      );

      // Prefer cached script (extendLock) over eval for performance (ADR-013)
      const scriptResult = redis.extendLock
        ? await redis.extendLock(
            lockIdKey,
            opts.lockId,
            TIME_TOLERANCE_MS.toString(),
            opts.ttlMs.toString(),
          )
        : ((await redis.eval(
            EXTEND_SCRIPT,
            1,
            lockIdKey,
            opts.lockId,
            TIME_TOLERANCE_MS.toString(),
            opts.ttlMs.toString(),
          )) as [number, number] | number);

      // Script returns: [1, expiresAtMs] on success, 0 on failure
      if (Array.isArray(scriptResult)) {
        const [status, expiresAtMs] = scriptResult;
        if (status === 1) {
          if (typeof expiresAtMs !== "number") {
            throw new LockError(
              "Internal",
              `Malformed script result: missing expiresAtMs`,
            );
          }
          return {
            ok: true,
            expiresAtMs,
          };
        }
        // Failure: attach telemetry metadata (0=mismatch, -1=not found, -2=expired)
        const result: ExtendResult = { ok: false };
        let reason: MutationReason;
        if (status === -2) {
          reason = "expired";
        } else {
          reason = "not-found"; // -1 or 0 → "not-found"
        }
        (result as any)[FAILURE_REASON] = { reason };
        return result;
      } else if (scriptResult === 1) {
        // Test mock: success without expiresAtMs
        return { ok: true, expiresAtMs: Date.now() + opts.ttlMs };
      } else {
        // Test mock: failure
        const result: ExtendResult = { ok: false };
        (result as any)[FAILURE_REASON] = {
          reason: "not-found" as MutationReason,
        };
        return result;
      }
    } catch (error) {
      if (error instanceof LockError) {
        throw error;
      }
      throw mapRedisError(error);
    }
  };
}
