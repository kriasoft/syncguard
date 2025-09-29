// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import Redis from "ioredis";
import type { LockBackend } from "../common/backend.js";
import { createRedisConfig } from "./config.js";
import { createAcquireOperation } from "./operations/acquire.js";
import { createExtendOperation } from "./operations/extend.js";
import { createIsLockedOperation } from "./operations/is-locked.js";
import { createLookupOperation } from "./operations/lookup.js";
import { createReleaseOperation } from "./operations/release.js";
import {
  ACQUIRE_SCRIPT,
  EXTEND_SCRIPT,
  IS_LOCKED_SCRIPT,
  LOOKUP_BY_KEY_SCRIPT,
  LOOKUP_BY_LOCKID_SCRIPT,
  RELEASE_SCRIPT,
} from "./scripts.js";
import type { RedisBackendOptions, RedisCapabilities } from "./types.js";

/**
 * Redis client with Lua script commands pre-registered.
 * Scripts are cached server-side for optimal performance.
 */
interface RedisWithCommands extends Redis {
  acquireLock(
    lockKey: string,
    lockIdKey: string,
    fenceKey: string,
    lockId: string,
    ttlMs: string,
    toleranceMs: string,
    key: string,
  ): Promise<[number, string] | number>;
  releaseLock(
    lockIdKey: string,
    keyPrefix: string,
    lockId: string,
    toleranceMs: string,
  ): Promise<number>;
  extendLock(
    lockIdKey: string,
    keyPrefix: string,
    lockId: string,
    toleranceMs: string,
    ttlMs: string,
  ): Promise<number>;
  checkLock(
    lockKey: string,
    keyPrefix: string,
    toleranceMs: string,
    enableCleanup: string,
  ): Promise<number>;
  lookupByKey(lockKey: string, toleranceMs: string): Promise<string | null>;
  lookupByLockId(
    lockIdKey: string,
    keyPrefix: string,
    lockId: string,
    toleranceMs: string,
  ): Promise<string | null>;
}

/**
 * Creates Redis-based distributed lock backend using Lua scripts for atomicity.
 *
 * Storage: Lock data at {keyPrefix}{lockKey}, lockId index at {keyPrefix}id:{lockId}
 *
 * @param redis - ioredis client instance
 * @param options - Backend configuration (keyPrefix, ttl, tolerance)
 * @returns LockBackend with server-side time authority
 * @see specs/redis.md
 */
export function createRedisBackend(
  redis: Redis,
  options: RedisBackendOptions = {},
): LockBackend<RedisCapabilities> {
  const config = createRedisConfig(options);

  // Register Lua scripts for server-side caching (avoids re-parsing on each call)
  if (typeof redis.defineCommand === "function") {
    redis.defineCommand("acquireLock", {
      numberOfKeys: 3,
      lua: ACQUIRE_SCRIPT,
    });

    redis.defineCommand("releaseLock", {
      numberOfKeys: 2,
      lua: RELEASE_SCRIPT,
    });

    redis.defineCommand("extendLock", {
      numberOfKeys: 2,
      lua: EXTEND_SCRIPT,
    });

    redis.defineCommand("checkLock", {
      numberOfKeys: 1,
      lua: IS_LOCKED_SCRIPT,
    });

    redis.defineCommand("lookupByKey", {
      numberOfKeys: 1,
      lua: LOOKUP_BY_KEY_SCRIPT,
    });

    redis.defineCommand("lookupByLockId", {
      numberOfKeys: 2,
      lua: LOOKUP_BY_LOCKID_SCRIPT,
    });
  }

  const redisWithCommands = redis as RedisWithCommands;

  const capabilities: Readonly<RedisCapabilities> = {
    backend: "redis",
    supportsFencing: true,
    timeAuthority: "server",
  };

  return {
    acquire: createAcquireOperation(redisWithCommands, config),
    release: createReleaseOperation(redisWithCommands, config),
    extend: createExtendOperation(redisWithCommands, config),
    isLocked: createIsLockedOperation(redisWithCommands, config),
    lookup: createLookupOperation(redisWithCommands, config),
    capabilities,
  };
}
