/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

import type { Redis } from "ioredis";
import type { LockConfig, LockResult } from "../../common/backend.js";
import { generateLockId, mergeLockConfig } from "../../common/backend.js";
import { withAcquireRetries } from "../retry.js";
import type { LockData, RedisConfig } from "../types.js";

/**
 * Lua script for atomic lock acquisition
 * This script:
 * 1. Checks if lock exists and is not expired
 * 2. If lock doesn't exist or is expired, creates new lock
 * 3. Properly cleans up old lockId index using keyPrefix
 * 4. Sets both main lock key and lockId index
 * 5. Returns 1 for success, 0 for failure
 */
const ACQUIRE_SCRIPT = `
local lockKey = KEYS[1]
local lockIdKey = KEYS[2]
local lockData = ARGV[1]
local ttlSeconds = tonumber(ARGV[2])
local currentTime = tonumber(ARGV[3])
local keyPrefix = ARGV[4]

-- Check if lock exists
local existingData = redis.call('GET', lockKey)
if existingData then
  local data = cjson.decode(existingData)
  -- If lock is not expired, return failure
  if data.expiresAt > currentTime then
    return 0
  end
  -- Lock is expired, we can clean up the old lockId index
  if data.lockId then
    local oldLockIdKey = keyPrefix .. 'id:' .. data.lockId
    redis.call('DEL', oldLockIdKey)
  end
end

-- Acquire the lock
redis.call('SET', lockKey, lockData, 'EX', ttlSeconds)
redis.call('SET', lockIdKey, lockKey, 'EX', ttlSeconds)
return 1
`;

/**
 * Creates an acquire operation for Redis backend
 */
export function createAcquireOperation(redis: Redis, config: RedisConfig) {
  return async (lockConfig: LockConfig): Promise<LockResult> => {
    const mergedConfig = mergeLockConfig(lockConfig);
    const lockId = generateLockId();
    const startTime = Date.now();

    try {
      const result = await withAcquireRetries(
        async () => {
          // Check timeout before starting operation
          if (Date.now() - startTime > mergedConfig.timeoutMs) {
            return {
              acquired: false,
              reason: "Acquisition timeout before operation",
            } as const;
          }

          const currentTime = Date.now();
          const expiresAt = currentTime + mergedConfig.ttlMs;
          const ttlSeconds = Math.ceil(mergedConfig.ttlMs / 1000);

          const lockKey = `${config.keyPrefix}${mergedConfig.key}`;
          const lockIdKey = `${config.keyPrefix}id:${lockId}`;

          const lockData: LockData = {
            lockId,
            expiresAt,
            createdAt: currentTime,
            key: mergedConfig.key,
          };

          // Final timeout check before Redis operation
          if (Date.now() - startTime > mergedConfig.timeoutMs) {
            return {
              acquired: false,
              reason: "Acquisition timeout before Redis operation",
            } as const;
          }

          const scriptResult = (await redis.eval(
            ACQUIRE_SCRIPT,
            2,
            lockKey,
            lockIdKey,
            JSON.stringify(lockData),
            ttlSeconds.toString(),
            currentTime.toString(),
            config.keyPrefix,
          )) as number;

          if (scriptResult === 1) {
            return { acquired: true, expiresAt } as const;
          } else {
            return {
              acquired: false,
              reason: "Lock already held",
            } as const;
          }
        },
        config,
        mergedConfig.timeoutMs,
      );

      if (result.acquired) {
        return {
          success: true,
          lockId,
          expiresAt: new Date(result.expiresAt!),
        };
      } else {
        return {
          success: false,
          error: result.reason || "Failed to acquire lock",
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      return {
        success: false,
        error: `Failed to acquire lock "${mergedConfig.key}": ${errorMessage}`,
      };
    }
  };
}
