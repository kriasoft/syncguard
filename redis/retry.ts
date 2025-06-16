/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

import { delay } from "../common/backend.js";
import type { RedisConfig } from "./types.js";

/**
 * Checks if an error is transient and should be retried
 */
export function isTransientError(error: unknown): boolean {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return (
    errorMessage.includes("ECONNRESET") ||
    errorMessage.includes("ENOTFOUND") ||
    errorMessage.includes("ECONNREFUSED") ||
    errorMessage.includes("ETIMEDOUT") ||
    errorMessage.includes("Connection lost") ||
    errorMessage.includes("Broken pipe") ||
    errorMessage.includes("timeout") ||
    errorMessage.includes("network")
  );
}

/**
 * Handles retry logic for Redis operations
 * Throws on failure after exhausting retries for transient errors
 */
export async function withRetries<T>(
  operation: () => Promise<T>,
  config: RedisConfig,
): Promise<T> {
  let attempts = 0;
  const maxAttempts = config.maxRetries + 1;
  let lastError: unknown;

  while (attempts < maxAttempts) {
    attempts++;

    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // If this is not a transient error, throw immediately
      if (!isTransientError(error)) {
        throw error;
      }

      // If we've exhausted all attempts for transient errors, throw the last error
      if (attempts === maxAttempts) {
        throw lastError;
      }

      // Wait before retrying transient errors
      await delay(config.retryDelayMs);
    }
  }

  // This should never be reached, but included for type safety
  throw lastError;
}

/**
 * Specialized retry logic for lock acquisition operations
 * Handles both lock contention (always retry) and system errors (transient retry only)
 */
export async function withAcquireRetries(
  operation: () => Promise<{
    acquired: boolean;
    lockId?: string;
    expiresAt?: number;
    reason?: string;
  }>,
  config: RedisConfig,
  timeoutMs: number,
): Promise<{
  acquired: boolean;
  lockId?: string;
  expiresAt?: number;
  reason?: string;
}> {
  let attempts = 0;
  const maxAttempts = config.maxRetries + 1;
  const startTime = Date.now();
  let lastError: unknown;

  while (attempts < maxAttempts) {
    // Check timeout before each attempt
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Lock acquisition timeout after ${timeoutMs}ms`);
    }

    attempts++;

    try {
      const result = await operation();

      // Check timeout after operation completes to ensure we don't return
      // success for operations that exceeded the timeout
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`Lock acquisition timeout after ${timeoutMs}ms`);
      }

      // If we got a result (success or legitimate contention), return it
      if (result.acquired || result.reason) {
        return result;
      }

      // Fallback case - treat as contention and retry
      if (attempts < maxAttempts) {
        await delay(config.retryDelayMs);
      }
    } catch (error) {
      lastError = error;

      // If this is not a transient error, throw immediately
      if (!isTransientError(error)) {
        throw error;
      }

      // If we've exhausted all attempts for transient errors, throw the last error
      if (attempts === maxAttempts) {
        throw lastError;
      }

      // Wait before retrying transient errors
      await delay(config.retryDelayMs);
    }
  }

  // If we exhausted retries due to contention, return the contention result
  return { acquired: false, reason: "Lock contention - max retries exceeded" };
}
