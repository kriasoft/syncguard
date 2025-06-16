/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

/**
 * Core types and interfaces for the distributed lock library
 */

/**
 * Configuration for acquiring a distributed lock
 */
export interface LockConfig {
  /** Unique key for the lock */
  key: string;
  /** Time to live in milliseconds (default: 30000) */
  ttlMs?: number;
  /** Delay between retries in milliseconds (default: 100) */
  retryDelayMs?: number;
  /** Maximum number of retries (default: 10) */
  maxRetries?: number;
  /** Timeout for acquiring the lock in milliseconds (default: 5000) */
  timeoutMs?: number;
}

/**
 * Result of a lock acquisition attempt
 */
export type LockResult =
  | { success: true; lockId: string; expiresAt: Date }
  | { success: false; error: string };

/**
 * Backend interface for implementing distributed locks
 */
export interface LockBackend {
  /** Acquire a distributed lock */
  acquire: (config: LockConfig) => Promise<LockResult>;
  /** Release a distributed lock by its ID */
  release: (lockId: string) => Promise<boolean>;
  /** Extend the TTL of an existing lock */
  extend: (lockId: string, ttl: number) => Promise<boolean>;
  /** Check if a key is currently locked */
  isLocked: (key: string) => Promise<boolean>;
}

/**
 * Error thrown when lock operations fail
 */
export class LockError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "LockError";
  }
}

/**
 * Standard error codes for lock operations
 */
export const LockErrorCodes = {
  ACQUISITION_FAILED: "ACQUISITION_FAILED",
  TIMEOUT: "TIMEOUT",
  ALREADY_LOCKED: "ALREADY_LOCKED",
  NOT_FOUND: "NOT_FOUND",
} as const;

export type LockErrorCode =
  (typeof LockErrorCodes)[keyof typeof LockErrorCodes];

/**
 * Function type for automatic lock management
 */
export interface LockFunction {
  <T>(fn: () => Promise<T>, config: LockConfig): Promise<T>;
  acquire: (config: LockConfig) => Promise<LockResult>;
  release: (lockId: string) => Promise<boolean>;
  extend: (lockId: string, ttl: number) => Promise<boolean>;
  isLocked: (key: string) => Promise<boolean>;
}

/**
 * Creates a distributed lock function with automatic lock management
 * @param backend The lock backend implementation
 * @returns A function that provides both automatic and manual lock operations
 */
export function createLock(backend: LockBackend): LockFunction {
  const withLock = async <T>(
    fn: () => Promise<T>,
    config: LockConfig,
  ): Promise<T> => {
    const lockResult = await backend.acquire(config);

    if (!lockResult.success) {
      throw new LockError(
        `Failed to acquire lock: ${lockResult.error}`,
        "ACQUISITION_FAILED",
      );
    }

    try {
      return await fn();
    } finally {
      try {
        await backend.release(lockResult.lockId);
      } catch (error) {
        // Log release failure but don't throw to avoid masking the main execution result
        // In production, this should be logged to your observability system
        console.warn(
          `Failed to release lock "${config.key}" (${lockResult.lockId}): ${
            error instanceof Error ? error.message : error
          }. Lock will expire naturally after TTL.`,
        );
      }
    }
  };

  // Attach manual operations as properties
  withLock.acquire = (config: LockConfig) => backend.acquire(config);
  withLock.release = (lockId: string) => backend.release(lockId);
  withLock.extend = (lockId: string, ttl: number) =>
    backend.extend(lockId, ttl);
  withLock.isLocked = (key: string) => backend.isLocked(key);

  return withLock as LockFunction;
}

/**
 * Utility function to generate a unique lock ID using crypto.randomUUID for better uniqueness
 */
export function generateLockId(): string {
  // Use crypto.randomUUID if available (Node.js 14.17+), fallback to timestamp + random
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older environments - use slice instead of deprecated substr
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Utility function to create a delay
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
  ttlMs: 30000,
  retryDelayMs: 100,
  maxRetries: 10,
  timeoutMs: 5000,
} as const;

/**
 * Helper type for merging configurations
 */
export type MergedLockConfig = Required<LockConfig>;

/**
 * Utility function to merge lock configuration with defaults
 */
export function mergeLockConfig(config: LockConfig): MergedLockConfig {
  return { ...DEFAULT_CONFIG, ...config };
}
