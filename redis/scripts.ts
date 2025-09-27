/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

/**
 * Lua script for atomic lock acquisition
 * This script:
 * 1. Checks if lock exists and is not expired
 * 2. If lock doesn't exist or is expired, creates new lock
 * 3. Properly cleans up old lockId index using keyPrefix
 * 4. Sets both main lock key and lockId index
 * 5. Returns 1 for success, 0 for failure
 */
export const ACQUIRE_SCRIPT = `
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
 * Lua script for atomic lock release
 * This script:
 * 1. Gets the lock key from the lockId index
 * 2. Verifies ownership by checking lockId in the lock data
 * 3. Deletes both main lock and lockId index if ownership is verified
 * 4. Returns 1 for success, 0 for failure (not found or not owned)
 */
export const RELEASE_SCRIPT = `
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
 * Lua script for atomic lock extension
 * This script:
 * 1. Gets the lock key from the lockId index
 * 2. Verifies ownership and that lock hasn't expired
 * 3. Updates the lock data with new expiration time
 * 4. Updates TTL on both keys
 * 5. Returns 1 for success, 0 for failure
 */
export const EXTEND_SCRIPT = `
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
 * Lua script for checking lock status with cleanup
 * This script:
 * 1. Gets the lock data
 * 2. Checks if it's expired
 * 3. If expired, cleans up both lock and lockId index (fire-and-forget)
 * 4. Returns 1 if locked and not expired, 0 otherwise
 */
export const IS_LOCKED_SCRIPT = `
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
