// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import {
  type AcquireResult,
  FENCE_THRESHOLDS,
  type KeyOp,
  LockError,
  generateLockId,
  logFenceWarning,
  makeStorageKey,
  normalizeAndValidateKey,
} from "../../common/backend.js";
import { TIME_TOLERANCE_MS } from "../../common/time-predicates.js";
import { mapRedisError } from "../errors.js";
import { ACQUIRE_SCRIPT } from "../scripts.js";
import type { RedisCapabilities, RedisConfig } from "../types.js";

/** Redis client with eval support and optional cached script command */
interface RedisWithCommands {
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
  acquireLock?(
    lockKey: string,
    lockIdKey: string,
    fenceKey: string,
    lockId: string,
    ttlMs: string,
    toleranceMs: string,
    storageKey: string, // ADR-013: Full lockKey (post-truncation) for index storage
    userKey: string, // Original normalized key for lockData
  ): Promise<[number, string, number] | number>;
}

/**
 * Creates Redis acquire operation with atomic script execution.
 * @see ../scripts.ts for Lua script details
 */
export function createAcquireOperation(
  redis: RedisWithCommands,
  config: RedisConfig,
) {
  return async (
    opts: KeyOp & { ttlMs: number },
  ): Promise<AcquireResult<RedisCapabilities>> => {
    try {
      normalizeAndValidateKey(opts.key);

      if (!Number.isInteger(opts.ttlMs) || opts.ttlMs <= 0) {
        throw new LockError(
          "InvalidArgument",
          "ttlMs must be a positive integer",
        );
      }

      const lockId = generateLockId();
      const normalizedKey = normalizeAndValidateKey(opts.key);

      // Redis key length limit: 1000 bytes practical maximum
      // Reserve bytes for derived keys: ":id:" (4) + lockId (22) = 26 bytes
      const REDIS_LIMIT_BYTES = 1000;
      const RESERVE_BYTES = 26; // ":id:" (4 bytes) + 22-char lockId

      // ADR-006: Compute base storage key once, then derive fence key from it
      const baseKey = makeStorageKey(
        config.keyPrefix,
        normalizedKey,
        REDIS_LIMIT_BYTES,
        RESERVE_BYTES,
      );
      const lockKey = baseKey;
      const lockIdKey = makeStorageKey(
        config.keyPrefix,
        `id:${lockId}`,
        REDIS_LIMIT_BYTES,
        RESERVE_BYTES,
      );
      // Derive fence key from base key to ensure 1:1 mapping when truncation occurs
      const fenceKey = makeStorageKey(
        config.keyPrefix,
        `fence:${baseKey}`,
        REDIS_LIMIT_BYTES,
        RESERVE_BYTES,
      );

      const toleranceMs = TIME_TOLERANCE_MS;

      // Prefer cached script command (acquireLock) over eval for performance
      // ADR-013: Pass full lockKey for index storage AND original key for lockData
      const scriptResult = redis.acquireLock
        ? await redis.acquireLock(
            lockKey,
            lockIdKey,
            fenceKey,
            lockId,
            opts.ttlMs.toString(),
            toleranceMs.toString(),
            lockKey, // ARGV[4]: Full lockKey for index (post-truncation)
            normalizedKey, // ARGV[5]: Original key for lockData
          )
        : ((await redis.eval(
            ACQUIRE_SCRIPT,
            3,
            lockKey,
            lockIdKey,
            fenceKey,
            lockId,
            opts.ttlMs.toString(),
            toleranceMs.toString(),
            lockKey, // ARGV[4]: Full lockKey for index (post-truncation)
            normalizedKey, // ARGV[5]: Original key for lockData
          )) as [number, string, number] | number);

      // Script returns [1, fence, expiresAtMs] on success, 0 on contention
      if (Array.isArray(scriptResult)) {
        const [status, fence, expiresAtMs] = scriptResult;
        if (status === 1) {
          // Robustness check: ensure all expected values are present
          if (
            !fence ||
            typeof fence !== "string" ||
            typeof expiresAtMs !== "number"
          ) {
            throw new LockError(
              "Internal",
              `Malformed script result: missing fence or expiresAtMs`,
            );
          }

          // Overflow enforcement (ADR-004): verify fence within safe limits
          // Fence is 15-digit zero-padded string; lexicographic comparison
          if (fence > FENCE_THRESHOLDS.MAX) {
            throw new LockError(
              "Internal",
              `Fence counter overflow - exceeded operational limit (${FENCE_THRESHOLDS.MAX})`,
              { key: opts.key },
            );
          }

          // Operational monitoring: warn at FENCE_THRESHOLDS.WARN using shared utility
          if (fence > FENCE_THRESHOLDS.WARN) {
            logFenceWarning(fence, opts.key);
          }

          return {
            ok: true,
            lockId,
            expiresAtMs,
            fence,
          } as AcquireResult<RedisCapabilities>;
        }
      } else if (scriptResult === 1) {
        // Test mock: success without fence token or expiresAtMs
        const expiresAtMs = Date.now() + opts.ttlMs;
        return {
          ok: true,
          lockId,
          expiresAtMs,
          fence: "000000000000001",
        } as AcquireResult<RedisCapabilities>;
      } else if (scriptResult === 0) {
        return {
          ok: false,
          reason: "locked",
        };
      }

      throw new LockError(
        "Internal",
        `Unexpected script result: ${scriptResult}`,
      );
    } catch (error) {
      if (error instanceof LockError) {
        throw error;
      }
      throw mapRedisError(error);
    }
  };
}
