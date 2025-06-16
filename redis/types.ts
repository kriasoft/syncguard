/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

/**
 * Configuration options specific to Redis backend
 */
export interface RedisBackendOptions {
  /** Redis key prefix for storing locks (default: "syncguard:") */
  keyPrefix?: string;
  /** Delay between retries in milliseconds (default: 100) */
  retryDelayMs?: number;
  /** Maximum number of retries (default: 10) */
  maxRetries?: number;
}

/**
 * Data structure for lock storage in Redis
 */
export interface LockData {
  /** Unique identifier for the lock */
  lockId: string;
  /** Timestamp when the lock expires */
  expiresAt: number;
  /** Timestamp when the lock was created */
  createdAt: number;
  /** Lock key for identification */
  key: string;
}

/**
 * Internal configuration with defaults applied
 */
export interface RedisConfig {
  keyPrefix: string;
  retryDelayMs: number;
  maxRetries: number;
}
