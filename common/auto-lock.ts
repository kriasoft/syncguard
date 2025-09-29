// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import { BACKEND_DEFAULTS, LOCK_DEFAULTS } from "./constants.js";
import { LockError } from "./errors.js";
import { delay } from "./helpers.js";
import type {
  AcquisitionOptions,
  BackendCapabilities,
  LockBackend,
  LockConfig,
} from "./types.js";
import { normalizeAndValidateKey } from "./validation.js";

/**
 * Auto-managed lock with retry logic for acquisition contention.
 * Backends perform single-attempt operations (ADR-009), retries handled here.
 * @see specs/adrs.md
 */

/**
 * Calculates retry delay with exponential/fixed backoff and optional jitter.
 * Clamps result to remaining timeout to prevent overshooting.
 *
 * @param attemptNumber - 1-based (first retry = 1)
 * @param baseDelay - Base delay in ms
 * @param backoff - "exponential" (2^n) or "fixed"
 * @param jitter - "equal" (50% fixed + 50% random), "full" (0-100% random), "none"
 * @param remainingTime - Time left before timeout
 * @returns Calculated delay in ms, clamped to remainingTime
 */
function calculateRetryDelay(
  attemptNumber: number,
  baseDelay: number,
  backoff: "exponential" | "fixed",
  jitter: "equal" | "full" | "none",
  remainingTime: number,
): number {
  let calcDelay: number;
  if (backoff === "exponential") {
    calcDelay = baseDelay * Math.pow(2, attemptNumber - 1);
  } else {
    calcDelay = baseDelay;
  }

  if (jitter === "equal") {
    calcDelay = calcDelay / 2 + Math.random() * (calcDelay / 2);
  } else if (jitter === "full") {
    calcDelay = Math.random() * calcDelay;
  }

  return Math.min(calcDelay, Math.max(0, remainingTime));
}

/**
 * Executes function with distributed lock, retries on contention, auto-releases.
 * Backends are single-attempt (ADR-009), retry logic here with backoff/jitter.
 * No telemetry (ADR-007) - use withTelemetry() decorator if needed.
 *
 * @param backend - Lock backend (Redis, Firestore, custom)
 * @param fn - Function to execute while holding lock
 * @param config - Lock config (key, ttlMs, acquisition retry options)
 * @returns Result of fn execution
 * @throws {LockError} AcquisitionTimeout, NetworkTimeout, or Internal
 * @see common/types.ts for LockConfig
 * @see specs/interface.md for usage examples
 */
/**
 * Creates a curried lock function bound to a specific backend.
 * Useful for creating reusable lock instances with a specific backend.
 *
 * @param backend - Lock backend (Redis, Firestore, custom)
 * @returns A function that accepts fn and config
 * @deprecated Use lock() directly instead
 */
export function createAutoLock<C extends BackendCapabilities>(
  backend: LockBackend<C>,
) {
  return <T>(
    fn: () => Promise<T> | T,
    config: LockConfig & { acquisition?: AcquisitionOptions },
  ): Promise<T> => {
    return lock(backend, fn, config);
  };
}

export async function lock<T, C extends BackendCapabilities>(
  backend: LockBackend<C>,
  fn: () => Promise<T> | T,
  config: LockConfig & { acquisition?: AcquisitionOptions },
): Promise<T> {
  const normalizedKey = normalizeAndValidateKey(config.key);

  const ttlMs = config.ttlMs ?? BACKEND_DEFAULTS.ttlMs;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new LockError("InvalidArgument", "ttlMs must be a positive integer");
  }

  // Merge user options with defaults from constants.ts
  const acquisitionOpts = {
    maxRetries: config.acquisition?.maxRetries ?? LOCK_DEFAULTS.maxRetries,
    retryDelayMs:
      config.acquisition?.retryDelayMs ?? LOCK_DEFAULTS.retryDelayMs,
    backoff: config.acquisition?.backoff ?? LOCK_DEFAULTS.backoff,
    jitter: config.acquisition?.jitter ?? LOCK_DEFAULTS.jitter,
    timeoutMs: config.acquisition?.timeoutMs ?? LOCK_DEFAULTS.timeoutMs,
    signal: config.acquisition?.signal,
  };

  const startTime = Date.now();
  let attempts = 0;
  let lockId: string | undefined;

  // Retry loop: attempts until acquired, max retries exceeded, or timeout
  while (true) {
    attempts++;

    // Timeout check before backend call to avoid wasted attempt
    const elapsedMs = Date.now() - startTime;
    if (elapsedMs >= acquisitionOpts.timeoutMs) {
      throw new LockError(
        "AcquisitionTimeout",
        `Failed to acquire lock after ${elapsedMs}ms (${attempts} attempts)`,
        { key: normalizedKey },
      );
    }

    // AbortSignal support for cancellation
    if (config.signal?.aborted) {
      throw new LockError(
        "NetworkTimeout",
        "Operation cancelled by user signal",
        { key: normalizedKey },
      );
    }
    if (acquisitionOpts.signal?.aborted) {
      throw new LockError(
        "NetworkTimeout",
        "Acquisition cancelled by acquisition signal",
        { key: normalizedKey },
      );
    }

    try {
      // Backend performs single attempt (no retries), returns ok or contention
      const result = await backend.acquire({
        key: normalizedKey,
        ttlMs,
        signal: config.signal,
      });

      if (result.ok) {
        lockId = result.lockId;
        break;
      }

      // Lock contention: check if retries exhausted
      if (attempts > acquisitionOpts.maxRetries) {
        throw new LockError(
          "AcquisitionTimeout",
          `Failed to acquire lock after ${attempts} attempts (lock contention)`,
          { key: normalizedKey },
        );
      }

      // Calculate backoff delay clamped to remaining timeout
      const remainingTime =
        acquisitionOpts.timeoutMs - (Date.now() - startTime);
      const retryDelay = calculateRetryDelay(
        attempts,
        acquisitionOpts.retryDelayMs,
        acquisitionOpts.backoff,
        acquisitionOpts.jitter,
        remainingTime,
      );

      if (retryDelay <= 0) {
        throw new LockError(
          "AcquisitionTimeout",
          `Timeout reached before next retry (${Date.now() - startTime}ms elapsed)`,
          { key: normalizedKey },
        );
      }

      await delay(retryDelay);
    } catch (error) {
      if (error instanceof LockError) {
        throw error;
      }

      // Wrap unexpected errors (network, system) as Internal
      throw new LockError(
        "Internal",
        error instanceof Error ? error.message : String(error),
        { key: normalizedKey, cause: error },
      );
    }
  }

  if (!lockId) {
    throw new LockError("Internal", "Lock acquired but no lockId returned");
  }

  // Execute user function, auto-release in finally block
  try {
    return await fn();
  } catch (error) {
    throw error; // Re-throw after release in finally
  } finally {
    // Best-effort release: don't throw, lock expires via TTL
    try {
      await backend.release({ lockId, signal: config.signal });
    } catch (releaseError) {
      if (config.onReleaseError) {
        const error =
          releaseError instanceof Error
            ? releaseError
            : new Error(String(releaseError));

        config.onReleaseError(error, { lockId, key: normalizedKey });
      }
      // Swallow release errors: TTL cleanup handles orphaned locks
    }
  }
}
