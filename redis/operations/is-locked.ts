// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import {
  type KeyOp,
  LockError,
  makeStorageKey,
  normalizeAndValidateKey,
} from "../../common/backend.js";
import { TIME_TOLERANCE_MS } from "../../common/time-predicates.js";
import { mapRedisError } from "../errors.js";
import { IS_LOCKED_SCRIPT } from "../scripts.js";
import type { RedisConfig } from "../types.js";

/**
 * Redis interface supporting both direct eval and cached command wrappers.
 * @see ../scripts.ts for Lua script definitions
 */
interface RedisWithCommands {
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
  /** Cached command wrapper for IS_LOCKED_SCRIPT (ioredis defineCommand) */
  checkLock?(
    lockKey: string,
    keyPrefix: string,
    toleranceMs: string,
    enableCleanup: string,
  ): Promise<number>;
}

/**
 * Creates isLocked operation using Lua script for atomicity.
 * Script checks expiration and optionally cleans up with safety guard.
 * @see ../scripts.ts for IS_LOCKED_SCRIPT implementation
 */
export function createIsLockedOperation(
  redis: RedisWithCommands,
  config: RedisConfig,
) {
  return async (opts: KeyOp): Promise<boolean> => {
    try {
      const normalizedKey = normalizeAndValidateKey(opts.key);

      const REDIS_LIMIT_BYTES = 1000;
      const RESERVE_BYTES = 26; // ":id:" (4 bytes) + 22-char lockId

      const lockKey = makeStorageKey(
        config.keyPrefix,
        normalizedKey,
        REDIS_LIMIT_BYTES,
        RESERVE_BYTES,
      );

      // Prefer cached command (ioredis) over eval for better performance
      const scriptResult = redis.checkLock
        ? await redis.checkLock(
            lockKey,
            config.keyPrefix,
            TIME_TOLERANCE_MS.toString(),
            config.cleanupInIsLocked.toString(),
          )
        : ((await redis.eval(
            IS_LOCKED_SCRIPT,
            1,
            lockKey,
            config.keyPrefix,
            TIME_TOLERANCE_MS.toString(),
            config.cleanupInIsLocked.toString(),
          )) as number);

      return scriptResult === 1;
    } catch (error) {
      if (error instanceof LockError) {
        throw error;
      }
      throw mapRedisError(error);
    }
  };
}
