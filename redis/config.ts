// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { RedisBackendOptions, RedisConfig } from "./types.js";

/**
 * Default configuration for Redis backend.
 * @see specs/redis.md
 */
export const REDIS_DEFAULTS = {
  /** Key prefix for Redis lock entries */
  keyPrefix: "syncguard",
  /** Cleanup expired locks in isLocked() - disabled for O(1) performance */
  cleanupInIsLocked: false,
} as const;

/**
 * Merges user options with defaults.
 * @param options - User-provided Redis configuration
 * @returns Complete Redis backend configuration
 */
export function createRedisConfig(
  options: RedisBackendOptions = {},
): RedisConfig {
  return {
    keyPrefix: options.keyPrefix ?? REDIS_DEFAULTS.keyPrefix,
    cleanupInIsLocked:
      options.cleanupInIsLocked ?? REDIS_DEFAULTS.cleanupInIsLocked,
  };
}
