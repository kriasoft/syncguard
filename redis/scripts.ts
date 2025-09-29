// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Atomic lock acquisition with fencing tokens.
 * Flow: check expiration → generate fence token → set both keys with TTL
 *
 * @returns {1, fence} on success, 0 on contention
 * @see specs/redis.md for acquire operation spec
 *
 * KEYS: [lockKey, lockIdKey, fenceKey]
 * ARGV: [lockId, ttlMs, toleranceMs, key]
 */
export const ACQUIRE_SCRIPT = `
local lockKey = KEYS[1]
local lockIdKey = KEYS[2]
local fenceKey = KEYS[3]
local lockId = ARGV[1]
local ttlMs = tonumber(ARGV[2])
local toleranceMs = tonumber(ARGV[3])
local key = ARGV[4]

-- Canonical time: Redis TIME converted to milliseconds
local time = redis.call('TIME')
local nowMs = time[1] * 1000 + math.floor(time[2] / 1000)
local existingData = redis.call('GET', lockKey)
if existingData then
  local data = cjson.decode(existingData)
  if data.expiresAtMs > (nowMs - toleranceMs) then  -- isLive() predicate
    return 0  -- Contention
  end
  if data.lockId then
    redis.call('DEL', lockIdKey)  -- Clean up expired lockId index
  end
end
-- INCR guarantees monotonic fencing tokens
local fenceNumber = redis.call('INCR', fenceKey)
local fence = string.format("%019d", fenceNumber)  -- Zero-padded for lexicographic ordering
-- Atomic dual-key write with identical TTL
local expiresAtMs = nowMs + ttlMs
local lockData = cjson.encode({lockId=lockId, expiresAtMs=expiresAtMs, acquiredAtMs=nowMs, key=key, fence=fence})
redis.call('SET', lockKey, lockData, 'PX', ttlMs)
redis.call('SET', lockIdKey, key, 'PX', ttlMs)  -- Reverse lookup index
return {1, fence}
`;

/**
 * Atomic lock release with ownership verification.
 * Flow: reverse lookup → verify ownership → delete
 *
 * @returns 1=success, 0=ownership mismatch, -1=not found, -2=expired
 * @see specs/adrs.md ADR-003 for ownership verification requirement
 *
 * KEYS: [lockIdKey, keyPrefix]
 * ARGV: [lockId, toleranceMs]
 */
export const RELEASE_SCRIPT = `
local lockIdKey = KEYS[1]
local keyPrefix = KEYS[2]
local lockId = ARGV[1]
local toleranceMs = tonumber(ARGV[2])

local time = redis.call('TIME')
local nowMs = time[1] * 1000 + math.floor(time[2] / 1000)

-- Reverse lookup: lockId → key
local key = redis.call('GET', lockIdKey)
if not key then return -1 end

-- Handle prefix with/without trailing colon
local lockKey
if string.sub(keyPrefix, -1) == ":" then
  lockKey = keyPrefix .. key
else
  lockKey = keyPrefix .. ":" .. key
end

local lockData = redis.call('GET', lockKey)
if not lockData then return -1 end

local data = cjson.decode(lockData)

-- Expired lock cleanup (inverted isLive predicate)
if data.expiresAtMs <= (nowMs - toleranceMs) then
  redis.call('DEL', lockKey, lockIdKey)
  return -2
end

-- Ownership verification (ADR-003: defense-in-depth)
if data.lockId ~= lockId then return 0 end

-- Atomic dual-key delete
redis.call('DEL', lockKey, lockIdKey)
return 1
`;

/**
 * Atomic lock extension with ownership verification.
 * Flow: reverse lookup → verify ownership → replace TTL entirely
 *
 * @returns 1=success, 0=ownership mismatch/not found/expired
 * @see specs/adrs.md ADR-003 for ownership verification requirement
 *
 * KEYS: [lockIdKey, keyPrefix]
 * ARGV: [lockId, toleranceMs, ttlMs]
 */
export const EXTEND_SCRIPT = `
local lockIdKey = KEYS[1]
local keyPrefix = KEYS[2]
local lockId = ARGV[1]
local toleranceMs = tonumber(ARGV[2])
local ttlMs = tonumber(ARGV[3])

local time = redis.call('TIME')
local nowMs = time[1] * 1000 + math.floor(time[2] / 1000)

local key = redis.call('GET', lockIdKey)
if not key then return 0 end

local lockKey
if string.sub(keyPrefix, -1) == ":" then
  lockKey = keyPrefix .. key
else
  lockKey = keyPrefix .. ":" .. key
end

local lockData = redis.call('GET', lockKey)
if not lockData then return 0 end

local data = cjson.decode(lockData)

-- Cleanup expired lock (simplified to return 0 for all failure modes)
if data.expiresAtMs <= (nowMs - toleranceMs) then
  redis.call('DEL', lockKey, lockIdKey)
  return 0
end

-- Ownership verification (ADR-003)
if data.lockId ~= lockId then return 0 end

-- Replace TTL entirely (not additive)
local newExpiresAtMs = nowMs + ttlMs
data.expiresAtMs = newExpiresAtMs
redis.call('SET', lockKey, cjson.encode(data), 'PX', ttlMs)
redis.call('SET', lockIdKey, key, 'PX', ttlMs)
return 1
`;

/**
 * Lock status check with optional expired lock cleanup.
 * Cleanup uses 2s safety buffer to prevent extend() race conditions.
 *
 * @returns 1 if locked and live, 0 otherwise
 * @see specs/redis.md for isLocked operation spec
 *
 * KEYS: [lockKey]
 * ARGV: [keyPrefix, toleranceMs, enableCleanup ("true"|"false")]
 */
export const IS_LOCKED_SCRIPT = `
local lockKey = KEYS[1]
local keyPrefix = ARGV[1]
local toleranceMs = tonumber(ARGV[2])
local enableCleanup = ARGV[3] == "true"

local time = redis.call('TIME')
local nowMs = time[1] * 1000 + math.floor(time[2] / 1000)

local lockData = redis.call('GET', lockKey)
if not lockData then
  return 0
end

local data = cjson.decode(lockData)
if data.expiresAtMs <= (nowMs - toleranceMs) then
  -- Optional cleanup with 2s safety buffer (prevents extend race conditions)
  if enableCleanup then
    local guardMs = 2000
    if nowMs - data.expiresAtMs > guardMs then
      redis.call('DEL', lockKey)
      if data.lockId then
        local lockIdKey
        if string.sub(keyPrefix, -1) == ":" then
          lockIdKey = keyPrefix .. 'id:' .. data.lockId
        else
          lockIdKey = keyPrefix .. ':id:' .. data.lockId
        end
        redis.call('DEL', lockIdKey)
      end
    end
  end
  return 0
end

return 1
`;

/**
 * Lookup lock by key.
 *
 * @returns lock info (JSON) if live, nil otherwise
 * @see specs/interface.md for lookup operation spec
 *
 * KEYS: [lockKey]
 * ARGV: [toleranceMs]
 */
export const LOOKUP_BY_KEY_SCRIPT = `
local lockKey = KEYS[1]
local toleranceMs = tonumber(ARGV[1])

local time = redis.call('TIME')
local nowMs = time[1] * 1000 + math.floor(time[2] / 1000)

local lockData = redis.call('GET', lockKey)
if not lockData then
  return nil
end

local data = cjson.decode(lockData)
if data.expiresAtMs <= (nowMs - toleranceMs) then
  return nil
end

return cjson.encode(data)
`;

/**
 * Lookup lock by lockId using reverse mapping.
 * Verifies ownership before returning lock info.
 *
 * @returns lock info (JSON) if live and owned, nil otherwise
 * @see specs/interface.md for lookup operation spec
 *
 * KEYS: [lockIdKey, keyPrefix]
 * ARGV: [lockId, toleranceMs]
 */
export const LOOKUP_BY_LOCKID_SCRIPT = `
local lockIdKey = KEYS[1]
local keyPrefix = KEYS[2]
local lockId = ARGV[1]
local toleranceMs = tonumber(ARGV[2])

local time = redis.call('TIME')
local nowMs = time[1] * 1000 + math.floor(time[2] / 1000)

local key = redis.call('GET', lockIdKey)
if not key then return nil end

local lockKey
if string.sub(keyPrefix, -1) == ":" then
  lockKey = keyPrefix .. key
else
  lockKey = keyPrefix .. ":" .. key
end
local lockData = redis.call('GET', lockKey)
if not lockData then return nil end

local data = cjson.decode(lockData)
if data.lockId ~= lockId then return nil end

if data.expiresAtMs <= (nowMs - toleranceMs) then return nil end

return lockData
`;
