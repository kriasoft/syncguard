// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import {
  type LockOp,
  type ReleaseResult,
  LockError,
  makeStorageKey,
  validateLockId,
} from "../../common/backend.js";
import { TIME_TOLERANCE_MS } from "../../common/time-predicates.js";
import { mapRedisError } from "../errors.js";
import { RELEASE_SCRIPT } from "../scripts.js";
import type { RedisConfig } from "../types.js";

/** Redis client with script caching support (see: scripts.ts) */
interface RedisWithCommands {
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
  releaseLock?(
    lockIdKey: string,
    lockId: string,
    toleranceMs: string,
  ): Promise<number>;
}

/**
 * Creates release operation using Lua script for atomic ownership check + delete.
 * @see ../scripts.ts for RELEASE_SCRIPT implementation
 */
export function createReleaseOperation(
  redis: RedisWithCommands,
  config: RedisConfig,
) {
  return async (opts: LockOp): Promise<ReleaseResult> => {
    try {
      validateLockId(opts.lockId);

      const REDIS_LIMIT_BYTES = 1000;
      const RESERVE_BYTES = 26; // ":id:" (4 bytes) + 22-char lockId

      const lockIdKey = makeStorageKey(
        config.keyPrefix,
        `id:${opts.lockId}`,
        REDIS_LIMIT_BYTES,
        RESERVE_BYTES,
      );

      const toleranceMs = TIME_TOLERANCE_MS;

      // ADR-013: Use cached script (releaseLock) if available, otherwise eval directly
      // No longer pass keyPrefix - lockKey is retrieved directly from index
      const scriptResult = redis.releaseLock
        ? await redis.releaseLock(
            lockIdKey,
            opts.lockId,
            toleranceMs.toString(),
          )
        : ((await redis.eval(
            RELEASE_SCRIPT,
            1, // Only 1 key now (lockIdKey)
            lockIdKey,
            opts.lockId,
            toleranceMs.toString(),
          )) as number);

      // Script returns 1 if lock was owned and deleted, 0 otherwise
      return { ok: scriptResult === 1 };
    } catch (error) {
      if (error instanceof LockError) {
        throw error;
      }
      throw mapRedisError(error);
    }
  };
}
