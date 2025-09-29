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
    keyPrefix: string,
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

      const lockIdKey = makeStorageKey(
        config.keyPrefix,
        `id:${opts.lockId}`,
        1000,
      );

      const toleranceMs = TIME_TOLERANCE_MS;

      // Use cached script (releaseLock) if available, otherwise eval directly
      const scriptResult = redis.releaseLock
        ? await redis.releaseLock(
            lockIdKey,
            config.keyPrefix,
            opts.lockId,
            toleranceMs.toString(),
          )
        : ((await redis.eval(
            RELEASE_SCRIPT,
            2,
            lockIdKey,
            config.keyPrefix,
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
