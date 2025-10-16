// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Atomic lock acquisition with fencing tokens.
 * Flow: check expiration → generate fence token → set both keys with identical TTL
 *
 * @returns {1, fence, expiresAtMs} on success, 0 on contention
 * @see specs/redis-backend.md
 *
 * KEYS: [lockKey, lockIdKey, fenceKey]
 * ARGV: [lockId, ttlMs, toleranceMs, storageKey, userKey]
 *
 * NOTE: storageKey = full computed lockKey (post-truncation) stored in index for retrieval.
 * userKey = original normalized key stored in lockData for lookup operations (ADR-013).
 */
export const ACQUIRE_SCRIPT = `
local lockKey = KEYS[1]
local lockIdKey = KEYS[2]
local fenceKey = KEYS[3]
local lockId = ARGV[1]
local ttlMs = tonumber(ARGV[2])
local toleranceMs = tonumber(ARGV[3])
local storageKey = ARGV[4]
local userKey = ARGV[5]

-- Redis TIME() converted to milliseconds for canonical time authority
local time = redis.call('TIME')
local nowMs = time[1] * 1000 + math.floor(time[2] / 1000)
local existingData = redis.call('GET', lockKey)
if existingData then
  local data = cjson.decode(existingData)
  if data.expiresAtMs > (nowMs - toleranceMs) then  -- isLive() predicate
    return 0  -- Contention
  end
  -- Expired lock index cleaned up by TTL (both keys share identical TTL)
end
-- INCR guarantees monotonic fencing, 15-digit format ensures Lua precision safety (2^53-1)
local fence = string.format("%015d", redis.call('INCR', fenceKey))
-- Atomic dual-key write with identical TTL
local expiresAtMs = nowMs + ttlMs
local lockData = cjson.encode({lockId=lockId, expiresAtMs=expiresAtMs, acquiredAtMs=nowMs, key=userKey, fence=fence})
redis.call('SET', lockKey, lockData, 'PX', ttlMs)
-- Store full lockKey in index (handles truncation, ADR-013)
redis.call('SET', lockIdKey, storageKey, 'PX', ttlMs)
return {1, fence, expiresAtMs}
`;

/**
 * Atomic lock release with ownership verification.
 * Flow: reverse lookup → verify ownership → atomic delete
 *
 * @returns 1=success, 0=ownership mismatch, -1=not found, -2=expired
 * @see specs/adrs.md (ADR-003: ownership verification, ADR-013: index retrieval)
 *
 * KEYS: [lockIdKey]
 * ARGV: [lockId, toleranceMs]
 */
export const RELEASE_SCRIPT = `
local lockIdKey = KEYS[1]
local lockId = ARGV[1]
local toleranceMs = tonumber(ARGV[2])

local time = redis.call('TIME')
local nowMs = time[1] * 1000 + math.floor(time[2] / 1000)

-- Reverse lookup returns full lockKey (post-truncation, ADR-013)
local lockKey = redis.call('GET', lockIdKey)
if not lockKey then return -1 end

local lockData = redis.call('GET', lockKey)
if not lockData then return -1 end

local data = cjson.decode(lockData)

-- Expired lock cleanup (inverted isLive predicate)
if data.expiresAtMs <= (nowMs - toleranceMs) then
  redis.call('DEL', lockKey, lockIdKey)
  return -2
end

-- Ownership verification (defense-in-depth, ADR-003)
if data.lockId ~= lockId then return 0 end

-- Atomic dual-key delete
redis.call('DEL', lockKey, lockIdKey)
return 1
`;

/**
 * Atomic lock extension with ownership verification.
 * Flow: reverse lookup → verify ownership → replace TTL entirely (not additive)
 *
 * @returns {1, newExpiresAtMs} on success, 0 on ownership mismatch/not found/expired
 * @see specs/adrs.md (ADR-003: ownership verification, ADR-013: index retrieval)
 *
 * KEYS: [lockIdKey]
 * ARGV: [lockId, toleranceMs, ttlMs]
 */
export const EXTEND_SCRIPT = `
local lockIdKey = KEYS[1]
local lockId = ARGV[1]
local toleranceMs = tonumber(ARGV[2])
local ttlMs = tonumber(ARGV[3])

local time = redis.call('TIME')
local nowMs = time[1] * 1000 + math.floor(time[2] / 1000)

-- Reverse lookup returns full lockKey (post-truncation, ADR-013)
local lockKey = redis.call('GET', lockIdKey)
if not lockKey then return 0 end

local lockData = redis.call('GET', lockKey)
if not lockData then return 0 end

local data = cjson.decode(lockData)

-- Expired lock cleanup (all failures → 0 for simplicity)
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
redis.call('SET', lockIdKey, lockKey, 'PX', ttlMs)
return {1, newExpiresAtMs}
`;

/**
 * Lock status check with optional expired lock cleanup.
 * Cleanup uses 2s safety buffer to prevent extend() race conditions.
 *
 * @returns 1 if locked and live, 0 otherwise
 * @see specs/redis-backend.md
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
  -- Optional cleanup with 2s guard to prevent extend race conditions
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
 * Lookup lock by key, returns info only if live.
 *
 * @returns lock info (JSON) if live, nil otherwise
 * @see specs/interface.md
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
 * Lookup lock by lockId using atomic reverse mapping.
 * Verifies ownership before returning lock info.
 *
 * NOTE: Atomicity prevents TOCTOU races during multi-key reads (ADR-011: required for
 * Redis multi-key pattern, optional for Firestore indexed queries). Lookup is DIAGNOSTIC
 * ONLY—correctness relies on atomic release/extend operations, NOT lookup results.
 *
 * @returns lock info (JSON) if live and owned, nil otherwise
 * @see specs/interface.md
 * @see specs/adrs.md (ADR-011: atomicity, ADR-013: index retrieval)
 *
 * KEYS: [lockIdKey]
 * ARGV: [lockId, toleranceMs]
 */
export const LOOKUP_BY_LOCKID_SCRIPT = `
local lockIdKey = KEYS[1]
local lockId = ARGV[1]
local toleranceMs = tonumber(ARGV[2])

local time = redis.call('TIME')
local nowMs = time[1] * 1000 + math.floor(time[2] / 1000)

-- Reverse lookup returns full lockKey (post-truncation, ADR-013)
local lockKey = redis.call('GET', lockIdKey)
if not lockKey then return nil end

local lockData = redis.call('GET', lockKey)
if not lockData then return nil end

local data = cjson.decode(lockData)
if data.lockId ~= lockId then return nil end

if data.expiresAtMs <= (nowMs - toleranceMs) then return nil end

return lockData
`;
