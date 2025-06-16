/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

import type { Redis } from "ioredis";
import type { LockFunction } from "../common/backend.js";
import { createLock as createBaseLock } from "../common/backend.js";
import { createRedisBackend } from "./backend.js";
import type { RedisBackendOptions } from "./types.js";

/**
 * Creates a distributed lock function using Redis backend
 * @param redis Redis instance (from ioredis)
 * @param options Backend-specific configuration options
 * @returns Lock function with automatic and manual operations
 */
export function createLock(
  redis: Redis,
  options: RedisBackendOptions = {},
): LockFunction {
  const backend = createRedisBackend(redis, options);
  return createBaseLock(backend);
}

// Re-export types and backend for advanced usage
export { createRedisBackend } from "./backend.js";
export type { LockData, RedisBackendOptions, RedisConfig } from "./types.js";
