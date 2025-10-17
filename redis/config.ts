// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import { LockError } from "../common/errors.js";
import type { RedisBackendOptions, RedisConfig } from "./types.js";

/**
 * Default configuration for Redis backend.
 * @see specs/redis-backend.md
 */
export const REDIS_DEFAULTS = {
  /** Key prefix for Redis lock entries */
  keyPrefix: "syncguard",
  /** Cleanup expired locks in isLocked() - disabled for O(1) performance */
  cleanupInIsLocked: false,
} as const;

/**
 * Merges user options with defaults and validates configuration.
 * @param options - User-provided Redis configuration
 * @returns Complete Redis backend configuration
 * @throws {LockError} If keyPrefix configuration could result in fence counter deletion
 */
export function createRedisConfig(
  options: RedisBackendOptions = {},
): RedisConfig {
  const keyPrefix = options.keyPrefix ?? REDIS_DEFAULTS.keyPrefix;

  // CRITICAL: Validate keyPrefix doesn't create namespace overlap with fence counters
  // Per specs/redis-backend.md: Cleanup MUST ONLY delete lock data keys, never fence counter keys
  // Fence keys use pattern: ${keyPrefix}:fence:*
  // Lock data uses pattern: ${keyPrefix}:* (main) and ${keyPrefix}:id:* (index)
  // This validation ensures fence keys are distinct from lock data keys
  if (
    keyPrefix &&
    (keyPrefix.includes("fence:") || keyPrefix.endsWith("fence"))
  ) {
    throw new LockError(
      "InvalidArgument",
      `keyPrefix cannot contain 'fence:' or end with 'fence' to prevent accidental fence counter deletion (current: ${keyPrefix})`,
    );
  }

  return {
    keyPrefix,
    cleanupInIsLocked:
      options.cleanupInIsLocked ?? REDIS_DEFAULTS.cleanupInIsLocked,
    onReleaseError: options.onReleaseError,
    disposeTimeoutMs: options.disposeTimeoutMs,
  };
}
