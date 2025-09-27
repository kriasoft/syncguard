/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

import Redis from "ioredis";
import type { LockBackend } from "../common/backend.js";
import { createRedisConfig } from "./config.js";
import { createAcquireOperation } from "./operations/acquire.js";
import { createExtendOperation } from "./operations/extend.js";
import { createIsLockedOperation } from "./operations/is-locked.js";
import { createReleaseOperation } from "./operations/release.js";
import type { RedisBackendOptions } from "./types.js";
import {
  ACQUIRE_SCRIPT,
  RELEASE_SCRIPT,
  EXTEND_SCRIPT,
  IS_LOCKED_SCRIPT,
} from "./scripts.js";

/**
 * Extended Redis interface with defined commands
 */
interface RedisWithCommands extends Redis {
  acquireLock(
    lockKey: string,
    lockIdKey: string,
    lockData: string,
    ttlSeconds: string,
    currentTime: string,
    keyPrefix: string,
  ): Promise<number>;
  releaseLock(lockIdKey: string, lockId: string): Promise<number>;
  extendLock(
    lockIdKey: string,
    lockId: string,
    ttlMs: string,
    currentTime: string,
  ): Promise<number>;
  checkLock(
    lockKey: string,
    keyPrefix: string,
    currentTime: string,
  ): Promise<number>;
}

/**
 * Creates a Redis-based distributed lock backend
 *
 * This backend uses Redis for lock storage with the following approach:
 * - Main lock data stored as JSON in key: {keyPrefix}{lockKey}
 * - Lock ID index stored in key: {keyPrefix}id:{lockId} with value = lockKey
 * - Atomic operations using Lua scripts for consistency
 * - TTL-based expiration with manual cleanup
 *
 * @param redis Redis instance (from ioredis)
 * @param options Backend-specific configuration options
 * @returns LockBackend implementation for Redis
 */
export function createRedisBackend(
  redis: Redis,
  options: RedisBackendOptions = {},
): LockBackend {
  const config = createRedisConfig(options);

  // Define Lua script commands for optimal caching (only if defineCommand exists)
  if (typeof redis.defineCommand === "function") {
    redis.defineCommand("acquireLock", {
      numberOfKeys: 2,
      lua: ACQUIRE_SCRIPT,
    });

    redis.defineCommand("releaseLock", {
      numberOfKeys: 1,
      lua: RELEASE_SCRIPT,
    });

    redis.defineCommand("extendLock", {
      numberOfKeys: 1,
      lua: EXTEND_SCRIPT,
    });

    redis.defineCommand("checkLock", {
      numberOfKeys: 1,
      lua: IS_LOCKED_SCRIPT,
    });
  }

  const redisWithCommands = redis as RedisWithCommands;

  return {
    acquire: createAcquireOperation(redisWithCommands, config),
    release: createReleaseOperation(redisWithCommands, config),
    extend: createExtendOperation(redisWithCommands, config),
    isLocked: createIsLockedOperation(redisWithCommands, config),
  };
}
