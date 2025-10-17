// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import Redis from "ioredis";
import type { LockBackend } from "../common/backend.js";
import { decorateAcquireResult } from "../common/disposable.js";
import { normalizeAndValidateKey } from "../common/validation.js";
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
    storageKey: string, // ADR-013: Full lockKey (post-truncation) for index storage
    userKey: string, // Original normalized key for lockData
  ): Promise<[number, string, number] | number>;
  releaseLock(
    lockIdKey: string,
    lockId: string,
    toleranceMs: string,
  ): Promise<number>;
  extendLock(
    lockIdKey: string,
    lockId: string,
    toleranceMs: string,
    ttlMs: string,
  ): Promise<[number, number] | number>;
  checkLock(
    lockKey: string,
    keyPrefix: string,
    toleranceMs: string,
    enableCleanup: string,
  ): Promise<number>;
  lookupByKey(lockKey: string, toleranceMs: string): Promise<string | null>;
  lookupByLockId(
    lockIdKey: string,
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
 * @see specs/redis-backend.md
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
      numberOfKeys: 1, // ADR-013: Only lockIdKey (no keyPrefix)
      lua: RELEASE_SCRIPT,
    });

    redis.defineCommand("extendLock", {
      numberOfKeys: 1, // ADR-013: Only lockIdKey (no keyPrefix)
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
      numberOfKeys: 1, // ADR-013: Only lockIdKey (no keyPrefix)
      lua: LOOKUP_BY_LOCKID_SCRIPT,
    });
  }

  const redisWithCommands = redis as RedisWithCommands;

  const capabilities: Readonly<RedisCapabilities> = {
    backend: "redis",
    supportsFencing: true,
    timeAuthority: "server",
  };

  // Create base operations
  const acquireCore = createAcquireOperation(redisWithCommands, config);
  const releaseOp = createReleaseOperation(redisWithCommands, config);
  const extendOp = createExtendOperation(redisWithCommands, config);

  // Create backend object with disposal support
  const backend: LockBackend<RedisCapabilities> = {
    acquire: async (opts) => {
      const normalizedKey = normalizeAndValidateKey(opts.key);
      const result = await acquireCore(opts);
      return decorateAcquireResult(
        backend,
        result,
        normalizedKey,
        config.onReleaseError,
        config.disposeTimeoutMs,
      );
    },
    release: releaseOp,
    extend: extendOp,
    isLocked: createIsLockedOperation(redisWithCommands, config),
    lookup: createLookupOperation(redisWithCommands, config),
    capabilities,
  };

  return backend;
}
