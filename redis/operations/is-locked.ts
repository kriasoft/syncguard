/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

import type { Redis } from "ioredis";
import { withRetries } from "../retry.js";
import type { RedisConfig } from "../types.js";

/**
 * Lua script for checking lock status with cleanup
 * This script:
 * 1. Gets the lock data
 * 2. Checks if it's expired
 * 3. If expired, cleans up both lock and lockId index (fire-and-forget)
 * 4. Returns 1 if locked and not expired, 0 otherwise
 */
const IS_LOCKED_SCRIPT = `
local lockKey = KEYS[1]
local keyPrefix = ARGV[1]
local currentTime = tonumber(ARGV[2])

-- Get the lock data
local lockData = redis.call('GET', lockKey)
if not lockData then
  return 0  -- No lock exists
end

-- Check if expired
local data = cjson.decode(lockData)
if data.expiresAt <= currentTime then
  -- Lock is expired, clean up (fire-and-forget)
  redis.call('DEL', lockKey)
  if data.lockId then
    local lockIdKey = keyPrefix .. 'id:' .. data.lockId
    redis.call('DEL', lockIdKey)
  end
  return 0
end

return 1  -- Lock exists and is not expired
`;

/**
 * Creates an isLocked operation for Redis backend
 */
export function createIsLockedOperation(redis: Redis, config: RedisConfig) {
  return async (key: string): Promise<boolean> => {
    return withRetries(async () => {
      const lockKey = `${config.keyPrefix}${key}`;
      const currentTime = Date.now();

      const scriptResult = (await redis.eval(
        IS_LOCKED_SCRIPT,
        1,
        lockKey,
        config.keyPrefix,
        currentTime.toString(),
      )) as number;

      return scriptResult === 1;
    }, config);
  };
}
