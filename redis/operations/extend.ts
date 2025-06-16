/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

import type { Redis } from "ioredis";
import { withRetries } from "../retry.js";
import type { RedisConfig } from "../types.js";

/**
 * Lua script for atomic lock extension
 * This script:
 * 1. Gets the lock key from the lockId index
 * 2. Verifies ownership and that lock hasn't expired
 * 3. Updates the lock data with new expiration time
 * 4. Updates TTL on both keys
 * 5. Returns 1 for success, 0 for failure
 */
const EXTEND_SCRIPT = `
local lockIdKey = KEYS[1]
local lockId = ARGV[1]
local ttlMs = tonumber(ARGV[2])
local currentTime = tonumber(ARGV[3])

-- Get the lock key from the lockId index
local lockKey = redis.call('GET', lockIdKey)
if not lockKey then
  return 0  -- Lock ID not found
end

-- Get the lock data
local lockData = redis.call('GET', lockKey)
if not lockData then
  -- Lock key doesn't exist, but lockId index does - clean up index
  redis.call('DEL', lockIdKey)
  return 0
end

-- Verify ownership and expiration
local data = cjson.decode(lockData)
if data.lockId ~= lockId then
  return 0  -- Not the owner
end

if data.expiresAt <= currentTime then
  return 0  -- Lock already expired
end

-- Update the lock data with new expiration
data.expiresAt = currentTime + ttlMs
local ttlSeconds = math.ceil(ttlMs / 1000)

-- Update both keys with new data and TTL
redis.call('SET', lockKey, cjson.encode(data), 'EX', ttlSeconds)
redis.call('EXPIRE', lockIdKey, ttlSeconds)

return 1
`;

/**
 * Creates an extend operation for Redis backend
 */
export function createExtendOperation(redis: Redis, config: RedisConfig) {
  return async (lockId: string, ttl: number): Promise<boolean> => {
    return withRetries(async () => {
      const lockIdKey = `${config.keyPrefix}id:${lockId}`;
      const currentTime = Date.now();

      const scriptResult = (await redis.eval(
        EXTEND_SCRIPT,
        1,
        lockIdKey,
        lockId,
        ttl.toString(),
        currentTime.toString(),
      )) as number;

      return scriptResult === 1;
    }, config);
  };
}
