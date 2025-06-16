/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

import type { RedisBackendOptions, RedisConfig } from "./types.js";

/**
 * Merges user options with default Redis backend configuration
 */
export function createRedisConfig(
  options: RedisBackendOptions = {},
): RedisConfig {
  return {
    keyPrefix: "syncguard:",
    retryDelayMs: 100,
    maxRetries: 10,
    ...options,
  };
}
