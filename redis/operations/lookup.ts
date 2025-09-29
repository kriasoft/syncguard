// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import {
  type KeyLookup,
  type LockInfo,
  type OwnershipLookup,
  attachRawData,
  LockError,
  makeStorageKey,
  normalizeAndValidateKey,
  sanitizeLockInfo,
  validateLockId,
} from "../../common/backend.js";
import { TIME_TOLERANCE_MS } from "../../common/time-predicates.js";
import { mapRedisError } from "../errors.js";
import { LOOKUP_BY_KEY_SCRIPT, LOOKUP_BY_LOCKID_SCRIPT } from "../scripts.js";
import type { RedisCapabilities, RedisConfig } from "../types.js";

/** Redis client with eval() and optional function commands */
interface RedisWithCommands {
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
  getLockInfoByKey?(
    lockKey: string,
    toleranceMs: string,
  ): Promise<string | null>;
  getLockInfoByLockId?(
    lockIdKey: string,
    lockId: string,
    keyPrefix: string,
    toleranceMs: string,
  ): Promise<string | null>;
}

/** Lock data structure stored in Redis as JSON */
interface RedisLockData {
  lockId: string;
  expiresAtMs: number;
  acquiredAtMs: number;
  key: string;
  fence: string;
}

/**
 * Creates lookup operation for Redis backend.
 * @returns Async function that retrieves lock info by key or lockId
 * @see ../scripts.ts for Lua script implementations
 */
export function createLookupOperation(
  redis: RedisWithCommands,
  config: RedisConfig,
) {
  return async (
    opts: KeyLookup | OwnershipLookup,
  ): Promise<LockInfo<RedisCapabilities> | null> => {
    try {
      let scriptResult: string | null;

      if ("key" in opts) {
        // Key lookup path: validates and normalizes key
        const normalizedKey = normalizeAndValidateKey(opts.key);
        const lockKey = makeStorageKey(config.keyPrefix, normalizedKey, 1000);

        // Use Redis function if available, fallback to eval()
        scriptResult = redis.getLockInfoByKey
          ? await redis.getLockInfoByKey(lockKey, TIME_TOLERANCE_MS.toString())
          : ((await redis.eval(
              LOOKUP_BY_KEY_SCRIPT,
              1,
              lockKey,
              TIME_TOLERANCE_MS.toString(),
            )) as string | null);
      } else {
        // LockId lookup path: validates lockId format
        validateLockId(opts.lockId);
        const lockIdKey = makeStorageKey(
          config.keyPrefix,
          `id:${opts.lockId}`,
          1000,
        );

        // Use Redis function if available, fallback to eval()
        scriptResult = redis.getLockInfoByLockId
          ? await redis.getLockInfoByLockId(
              lockIdKey,
              config.keyPrefix,
              opts.lockId,
              TIME_TOLERANCE_MS.toString(),
            )
          : ((await redis.eval(
              LOOKUP_BY_LOCKID_SCRIPT,
              2,
              lockIdKey,
              config.keyPrefix,
              opts.lockId,
              TIME_TOLERANCE_MS.toString(),
            )) as string | null);
      }

      if (!scriptResult) {
        return null; // Lock not found or expired
      }

      const lockData: RedisLockData = JSON.parse(scriptResult);

      const capabilities: RedisCapabilities = {
        backend: "redis",
        supportsFencing: true,
        timeAuthority: "server",
      };

      const lockInfo = sanitizeLockInfo(lockData, capabilities);

      // Preserve raw data for debugging (see: common/helpers.ts lookupDebug)
      return attachRawData(lockInfo, {
        key: lockData.key,
        lockId: lockData.lockId,
      });
    } catch (error) {
      if (error instanceof LockError) {
        throw error;
      }
      throw mapRedisError(error);
    }
  };
}
