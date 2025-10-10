// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { BackendCapabilities } from "../common/backend.js";

/**
 * Redis-specific backend capabilities
 */
export interface RedisCapabilities extends BackendCapabilities {
  /** Backend type discriminant */
  backend: "redis";
  /** Redis always provides fencing tokens */
  supportsFencing: true;
  /** Uses Redis server time with unified tolerance */
  timeAuthority: "server";
}

/**
 * Configuration options specific to Redis backend
 */
export interface RedisBackendOptions {
  /** Redis key prefix for storing locks (default: "syncguard") */
  keyPrefix?: string;
  /** Enable cleanup in isLocked operation (default: false) */
  cleanupInIsLocked?: boolean;
}

/**
 * Data structure for lock storage in Redis
 */
export interface LockData {
  /** Unique identifier for ownership verification */
  lockId: string;
  /** Expiration timestamp in ms (Unix epoch) */
  expiresAtMs: number;
  /** Acquisition timestamp in ms (Unix epoch) */
  acquiredAtMs: number;
  /** Lock key for identification */
  key: string;
  /** Monotonic fencing token (16-digit zero-padded decimal per ADR-004) */
  fence: string;
}

/**
 * Internal configuration with defaults applied
 */
export interface RedisConfig {
  keyPrefix: string;
  cleanupInIsLocked: boolean;
}
