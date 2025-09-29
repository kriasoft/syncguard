// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { Redis } from "ioredis";
import { createAutoLock } from "../common/backend.js";
import { createRedisBackend } from "./backend.js";
import type { RedisBackendOptions } from "./types.js";

/**
 * Creates distributed lock with Redis backend via ioredis client
 * @param redis - ioredis client instance
 * @param options - Retry, TTL, and key prefix config
 * @returns Auto-managed lock function (see: common/auto-lock.ts)
 */
export function createLock(redis: Redis, options: RedisBackendOptions = {}) {
  const backend = createRedisBackend(redis, options);
  return createAutoLock(backend);
}

// Re-exports for custom backend implementations
export { createRedisBackend } from "./backend.js";
export type { LockData, RedisBackendOptions, RedisConfig } from "./types.js";
