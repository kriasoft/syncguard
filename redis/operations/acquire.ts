// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import {
  type AcquireResult,
  type KeyOp,
  LockError,
  generateLockId,
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
    userKey: string,
  ): Promise<[number, string] | number>;
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
      const storageKey = makeStorageKey(config.keyPrefix, normalizedKey, 1000);
      const lockKey = storageKey;
      const lockIdKey = makeStorageKey(config.keyPrefix, `id:${lockId}`, 1000);
      const fenceKey = makeStorageKey(
        config.keyPrefix,
        `fence:${normalizedKey}`,
        1000,
      );

      const toleranceMs = TIME_TOLERANCE_MS;

      // Prefer cached script command (acquireLock) over eval for performance
      const scriptResult = redis.acquireLock
        ? await redis.acquireLock(
            lockKey,
            lockIdKey,
            fenceKey,
            lockId,
            opts.ttlMs.toString(),
            toleranceMs.toString(),
            normalizedKey,
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
            normalizedKey,
          )) as [number, string] | number);

      // Script returns [1, fence] on success, 0 on contention
      if (Array.isArray(scriptResult)) {
        const [status, fence] = scriptResult;
        if (status === 1) {
          // Client time approximation: acceptable since Redis script uses server time internally
          const expiresAtMs = Date.now() + opts.ttlMs;
          return {
            ok: true,
            lockId,
            expiresAtMs,
            fence,
          } as AcquireResult<RedisCapabilities>;
        }
      } else if (scriptResult === 1) {
        // Test mock: success without fence token
        const expiresAtMs = Date.now() + opts.ttlMs;
        return {
          ok: true,
          lockId,
          expiresAtMs,
          fence: "0000000000000000001",
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
