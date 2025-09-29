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
    keyPrefix: string,
    lockId: string,
    toleranceMs: string,
    ttlMs: string,
  ): Promise<[number, number] | number>;
}

/**
 * Creates extend operation that atomically renews lock TTL.
 * @see specs/redis.md for Lua script implementation
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

      const lockIdKey = makeStorageKey(
        config.keyPrefix,
        `id:${opts.lockId}`,
        1000,
      );

      // Prefer cached script method (extendLock) over eval for performance
      const scriptResult = redis.extendLock
        ? await redis.extendLock(
            lockIdKey,
            config.keyPrefix,
            opts.lockId,
            TIME_TOLERANCE_MS.toString(),
            opts.ttlMs.toString(),
          )
        : ((await redis.eval(
            EXTEND_SCRIPT,
            2, // KEYS[1]=lockIdKey, KEYS[2]=keyPrefix
            lockIdKey,
            config.keyPrefix,
            opts.lockId, // ARGV[1]
            TIME_TOLERANCE_MS.toString(), // ARGV[2]
            opts.ttlMs.toString(), // ARGV[3]
          )) as [number, number] | number);

      // Script returns: 1 (success) or [1, expiresAtMs] (success + timestamp) or 0 (failed)
      if (Array.isArray(scriptResult)) {
        const [status, expiresAtMs] = scriptResult;
        if (status === 1) {
          return {
            ok: true,
            expiresAtMs: expiresAtMs || Date.now() + opts.ttlMs,
          };
        }
        return { ok: false };
      } else if (scriptResult === 1) {
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
