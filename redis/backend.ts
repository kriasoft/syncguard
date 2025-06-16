/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

import type { Redis } from "ioredis";
import type { LockBackend } from "../common/backend.js";
import { createRedisConfig } from "./config.js";
import { createAcquireOperation } from "./operations/acquire.js";
import { createExtendOperation } from "./operations/extend.js";
import { createIsLockedOperation } from "./operations/is-locked.js";
import { createReleaseOperation } from "./operations/release.js";
import type { RedisBackendOptions } from "./types.js";

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

  return {
    acquire: createAcquireOperation(redis, config),
    release: createReleaseOperation(redis, config),
    extend: createExtendOperation(redis, config),
    isLocked: createIsLockedOperation(redis, config),
  };
}
