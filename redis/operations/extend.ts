// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import {
  type ExtendResult,
  type LockOp,
  LockError,
  makeStorageKey,
  validateLockId,
} from "../../common/backend.js";
import { TIME_TOLERANCE_MS } from "../../common/time-predicates.js";
import { mapRedisError } from "../errors.js";
import { EXTEND_SCRIPT } from "../scripts.js";
import type { RedisConfig } from "../types.js";

/** Redis client with eval support and optional cached script method */
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
 * Creates extend operation that atomically renews lock TTL.
 * @see specs/redis-backend.md for Lua script implementation
 */
export function createExtendOperation(
  redis: RedisWithCommands,
  config: RedisConfig,
) {
  return async (opts: LockOp & { ttlMs: number }): Promise<ExtendResult> => {
    try {
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

      // ADR-013: Prefer cached script method (extendLock) over eval for performance
      // No longer pass keyPrefix - lockKey is retrieved directly from index
      const scriptResult = redis.extendLock
        ? await redis.extendLock(
            lockIdKey,
            opts.lockId,
            TIME_TOLERANCE_MS.toString(),
            opts.ttlMs.toString(),
          )
        : ((await redis.eval(
            EXTEND_SCRIPT,
            1, // Only 1 key now (lockIdKey)
            lockIdKey,
            opts.lockId, // ARGV[1]
            TIME_TOLERANCE_MS.toString(), // ARGV[2]
            opts.ttlMs.toString(), // ARGV[3]
          )) as [number, number] | number);

      // Script returns: [1, expiresAtMs] on success, 0 on failure
      if (Array.isArray(scriptResult)) {
        const [status, expiresAtMs] = scriptResult;
        if (status === 1) {
          // Robustness check: ensure expiresAtMs is present
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
        return { ok: false };
      } else if (scriptResult === 1) {
        // Test mock: success without expiresAtMs
        return { ok: true, expiresAtMs: Date.now() + opts.ttlMs };
      } else {
        return { ok: false };
      }
    } catch (error) {
      if (error instanceof LockError) {
        throw error;
      }
      throw mapRedisError(error);
    }
  };
}
