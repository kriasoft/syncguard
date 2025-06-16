/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

import type { Redis } from "ioredis";
import { withRetries } from "../retry.js";
import type { RedisConfig } from "../types.js";

/**
 * Lua script for atomic lock release
 * This script:
 * 1. Gets the lock key from the lockId index
 * 2. Verifies ownership by checking lockId in the lock data
 * 3. Deletes both main lock and lockId index if ownership is verified
 * 4. Returns 1 for success, 0 for failure (not found or not owned)
 */
const RELEASE_SCRIPT = `
local lockIdKey = KEYS[1]
local lockId = ARGV[1]

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

-- Verify ownership
local data = cjson.decode(lockData)
if data.lockId ~= lockId then
  return 0  -- Not the owner
end

-- Delete both keys atomically
redis.call('DEL', lockKey)
redis.call('DEL', lockIdKey)
return 1
`;

/**
 * Creates a release operation for Redis backend
 */
export function createReleaseOperation(redis: Redis, config: RedisConfig) {
  return async (lockId: string): Promise<boolean> => {
    return withRetries(async () => {
      const lockIdKey = `${config.keyPrefix}id:${lockId}`;

      const scriptResult = (await redis.eval(
        RELEASE_SCRIPT,
        1,
        lockIdKey,
        lockId,
      )) as number;

      return scriptResult === 1;
    }, config);
  };
}
