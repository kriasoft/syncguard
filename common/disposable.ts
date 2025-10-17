// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * AsyncDisposable support for automatic lock cleanup with `await using` syntax.
 *
 * Provides RAII (Resource Acquisition Is Initialization) pattern for locks,
 * ensuring cleanup on all code paths including early returns and exceptions.
 *
 * ## Default Error Handling
 *
 * **NEW**: Disposal errors are now observable by default to prevent silent failures.
 * - Development (NODE_ENV !== 'production'): Logs to console.error
 * - Production: Silent unless SYNCGUARD_DEBUG=true
 * - Security: Omits sensitive data (key, lockId) from default logs
 *
 * **Production Best Practice**: Override with custom callback integrated with your
 * logging/metrics infrastructure:
 *
 * ```typescript
 * const backend = createRedisBackend(redis, {
 *   onReleaseError: (err, ctx) => {
 *     logger.error('Lock disposal failed', { err, ...ctx });
 *     metrics.increment('syncguard.disposal.error');
 *   },
 * });
 * ```
 *
 * ## Configuration Patterns
 *
 * There are two independent ways to configure error callbacks, serving different APIs:
 *
 * ### Pattern A: Backend-level (for low-level `await using` API)
 * Configure once at backend creation for all acquisitions:
 * ```typescript
 * const backend = createRedisBackend(redis, {
 *   onReleaseError: (err, ctx) => logger.error("Disposal error", err, ctx),
 *   disposeTimeoutMs: 5000 // Optional: timeout disposal after 5s
 * });
 *
 * await using lock = await backend.acquire({ key, ttlMs });
 * // Disposal errors automatically route to backend's onReleaseError
 * ```
 *
 * ### Pattern B: Lock-level (for high-level `lock()` helper)
 * Configure per-call for fine-grained control:
 * ```typescript
 * const backend = createRedisBackend(redis); // Uses default callback
 *
 * await lock(backend, {
 *   key,
 *   onReleaseError: (err, ctx) => logger.error("Lock error", err, ctx),
 *   async fn(handle) { ... }
 * });
 * ```
 *
 * **Note**: These are independent configurations for different usage patterns.
 * Choose the pattern that matches your API usage - you typically won't mix them.
 *
 * @see specs/interface.md#resource-management - Normative specification
 * @see specs/adrs.md#adr-015-async-raii-for-locks - ADR-015: Async RAII for Locks
 * @see specs/adrs.md#adr-016-opt-in-disposal-timeout - ADR-016: Opt-In Disposal Timeout
 */

import type {
  AcquireOk,
  AcquireResult,
  BackendCapabilities,
  DecoratedAcquireResult,
  ExtendResult,
  KeyOp,
  LockBackend,
  OnReleaseError,
  ReleaseResult,
} from "./types.js";

// Re-export for backward compatibility
export type { OnReleaseError } from "./types.js";

// ============================================================================
// Default Error Handler
// ============================================================================

/**
 * Default error handler for disposal failures.
 * Provides safe-by-default observability without requiring user configuration.
 *
 * **Behavior**:
 * - Development (NODE_ENV !== 'production'): Logs all disposal errors to console.error
 * - Production: Silent by default (unless SYNCGUARD_DEBUG=true environment variable is set)
 * - Security: Omits sensitive context (key, lockId) from logs by default
 *
 * **Important Note**:
 * - This default handler is ONLY used when no custom `onReleaseError` is provided
 * - If you provide a custom callback, it will ALWAYS be invoked (regardless of environment)
 * - The silence behavior only applies to the built-in default handler
 *
 * **Production Usage**:
 * For production systems, strongly recommended to provide a custom onReleaseError callback
 * that integrates with your logging/metrics infrastructure:
 *
 * ```typescript
 * const backend = createRedisBackend(redis, {
 *   onReleaseError: (err, ctx) => {
 *     logger.error('Lock disposal failed', {
 *       error: err.message,
 *       source: ctx.source,
 *       key: ctx.key,
 *       lockId: ctx.lockId,
 *     });
 *     metrics.increment('syncguard.disposal.error', { source: ctx.source });
 *   },
 * });
 * ```
 *
 * @see specs/interface.md#error-handling - Error handling best practices
 * @see specs/adrs.md#adr-015-async-raii-for-locks - Disposal error semantics
 */
const defaultDisposalErrorHandler: OnReleaseError = (err, ctx) => {
  // Only log in development or when explicitly enabled via env var
  const shouldLog =
    process.env.NODE_ENV !== "production" ||
    process.env.SYNCGUARD_DEBUG === "true";

  if (shouldLog) {
    console.error("[SyncGuard] Lock disposal failed:", {
      error: err.message,
      errorName: err.name,
      source: ctx.source,
      // Omit key and lockId to avoid leaking sensitive data in logs
      // Users should provide custom callback for full context
    });
  }
};

// ============================================================================
// Types
// ============================================================================

/**
 * Lock handle with resource management methods.
 * Extends acquire result with release/extend operations and async disposal.
 */
export interface DisposableLockHandle {
  /**
   * Manually release the lock. Idempotent - safe to call multiple times.
   * Returns { ok: false } if lock was already released or absent.
   *
   * **Error handling**: Throws on system errors (network failures, auth errors)
   * for consistency with backend API. Only automatic disposal (via `await using`)
   * swallows errors and routes them to onReleaseError callback.
   *
   * @param signal Optional AbortSignal to cancel the release operation
   * @throws Error on system failures (network timeouts, service unavailable)
   */
  release(signal?: AbortSignal): Promise<ReleaseResult>;

  /**
   * Extend lock TTL. Returns { ok: false } if lock was already released or absent.
   * @param ttlMs New TTL in milliseconds (resets expiration to now + ttlMs)
   * @param signal Optional AbortSignal to cancel the extend operation
   * @throws Error on system failures (network timeouts, service unavailable)
   */
  extend(ttlMs: number, signal?: AbortSignal): Promise<ExtendResult>;

  /**
   * Automatic cleanup on scope exit (used by `await using` syntax).
   * Never throws - errors are swallowed and optionally routed to onReleaseError callback.
   */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Successful acquisition with automatic cleanup support.
 * Use with `await using` for automatic lock release on scope exit.
 *
 * @example
 * ```typescript
 * await using lock = await backend.acquire({ key, ttlMs: 15_000 });
 * if (!lock.ok) throw new Error("Failed to acquire lock");
 * // TypeScript narrows lock to AsyncLock<C> after ok check
 * await doWork(lock.fence);
 * // Lock automatically released on scope exit
 * ```
 */
export type AsyncLock<C extends BackendCapabilities> = AcquireOk<C> &
  DisposableLockHandle;

// ============================================================================
// Core Factory
// ============================================================================

/**
 * Creates a disposable lock handle from a successful acquisition.
 * Internal utility - use decorateAcquireResult() for public API.
 *
 * @param backend Backend operations (release, extend)
 * @param result Successful acquisition result
 * @param key Original normalized key for error context
 * @param onReleaseError Error callback for disposal failures (defaults to defaultDisposalErrorHandler)
 * @param disposeTimeoutMs Optional timeout for disposal operations in ms
 * @returns AsyncLock with disposal support
 */
export function createDisposableHandle<C extends BackendCapabilities>(
  backend: Pick<LockBackend<C>, "release" | "extend">,
  result: AcquireOk<C>,
  key: string,
  onReleaseError: OnReleaseError = defaultDisposalErrorHandler,
  disposeTimeoutMs?: number,
): AsyncLock<C> {
  // State machine for disposal idempotency (at-most-once semantics)
  // Ensures multiple release() or disposal calls don't retry network I/O
  type State = "active" | "disposing" | "disposed";
  let state: State = "active";
  let disposePromise: Promise<void> | null = null;

  const handle: DisposableLockHandle = {
    async release(signal?: AbortSignal): Promise<ReleaseResult> {
      // Idempotent: subsequent calls return { ok: false } without network call
      // This provides at-most-once semantics required by spec
      if (state === "disposing" || state === "disposed") {
        return { ok: false };
      }

      // Mark as disposing before backend call to ensure at-most-once semantics
      // even if the call throws (network error, timeout, etc.)
      state = "disposing";

      try {
        // Throw on errors for consistency with backend API
        // Only disposal swallows errors (see asyncDispose below)
        const releaseResult = await backend.release({
          lockId: result.lockId,
          signal,
        });
        state = "disposed";
        return releaseResult;
      } catch (error) {
        // Release failed - mark as disposed anyway (at-most-once semantics)
        state = "disposed";
        throw error;
      }
    },

    async extend(ttlMs: number, signal?: AbortSignal): Promise<ExtendResult> {
      // Note: extend() is NOT idempotent - it's a legitimate operation
      // to extend multiple times. Don't check state here.
      return backend.extend({ lockId: result.lockId, ttlMs, signal });
    },

    async [Symbol.asyncDispose](): Promise<void> {
      // Idempotent: subsequent calls are no-ops (at-most-once semantics)
      if (state === "disposed") {
        return;
      }

      // Re-entry during disposal: return same promise (idempotent)
      if (state === "disposing") {
        return disposePromise!;
      }

      // First disposal attempt: create and store promise
      state = "disposing";
      disposePromise = (async () => {
        try {
          // Apply timeout if configured
          // Note: Timeout only aborts the signal; if the backend doesn't respect
          // AbortSignal, the operation may still hang. Backends should implement
          // proper signal handling for timeout to be effective.
          if (typeof disposeTimeoutMs === "number" && disposeTimeoutMs > 0) {
            const controller = new AbortController();
            const timeoutId = setTimeout(
              () => controller.abort(),
              disposeTimeoutMs,
            );
            try {
              await backend.release({
                lockId: result.lockId,
                signal: controller.signal,
              });
            } finally {
              clearTimeout(timeoutId);
            }
          } else {
            await backend.release({ lockId: result.lockId });
          }
          // Success - mark as disposed
          state = "disposed";
        } catch (error) {
          // Disposal failed - mark as disposed anyway (at-most-once semantics)
          state = "disposed";

          // Never throw from disposal per AsyncDisposable spec
          // Always notify callback of disposal failure (uses default if not configured)
          try {
            // Normalize to Error instance and preserve original for debugging
            let normalizedError: Error;
            if (error instanceof Error) {
              normalizedError = error;
            } else {
              normalizedError = new Error(String(error));
              // Preserve original error for debugging
              (normalizedError as any).originalError = error;
            }

            onReleaseError(normalizedError, {
              lockId: result.lockId,
              key,
              source: "disposal",
            });
          } catch {
            // Swallow callback errors - user's callback is responsible for safe error handling
          }
          // Error is swallowed - disposal is best-effort cleanup
        }
      })();

      return disposePromise;
    },
  };

  // Return object with both data and methods
  // TypeScript sees this as AcquireOk<C> & DisposableLockHandle
  return Object.assign({}, result, handle) as AsyncLock<C>;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Decorates an acquire result with async disposal support.
 * This is the main integration point for backends.
 *
 * - If acquisition succeeded (ok: true): Returns AsyncLock with disposal methods
 * - If acquisition failed (ok: false): Returns result with no-op disposal
 *
 * **Error Handling**: Disposal errors are routed to the onReleaseError callback.
 * If not provided, uses defaultDisposalErrorHandler which logs in development
 * and is silent in production (unless SYNCGUARD_DEBUG=true).
 *
 * @param backend Backend instance for release/extend operations
 * @param result Raw acquisition result from backend
 * @param key Original normalized key for error context
 * @param onReleaseError Callback for disposal errors (defaults to defaultDisposalErrorHandler)
 * @param disposeTimeoutMs Optional timeout for disposal operations in ms
 * @returns Decorated result with disposal support
 *
 * @example
 * ```typescript
 * // In backend implementation:
 * const backend = {
 *   acquire: async (opts) => {
 *     const normalizedKey = normalizeAndValidateKey(opts.key);
 *     const result = await acquireCore(opts);
 *     return decorateAcquireResult(
 *       backend,
 *       result,
 *       normalizedKey,
 *       config.onReleaseError,  // Pass through user config or use default
 *       config.disposeTimeoutMs
 *     );
 *   },
 *   // ...
 * };
 * ```
 */
export function decorateAcquireResult<C extends BackendCapabilities>(
  backend: Pick<LockBackend<C>, "release" | "extend">,
  result: AcquireResult<C>,
  key: string,
  onReleaseError: OnReleaseError = defaultDisposalErrorHandler,
  disposeTimeoutMs?: number,
): DecoratedAcquireResult<C> {
  if (!result.ok) {
    // Failed acquisition: attach no-op methods for await using compatibility
    const failResult = result as any;

    // No-op disposal for failed acquisitions
    failResult[Symbol.asyncDispose] = async () => {
      // No-op - acquisition failed, nothing to clean up
    };

    // No-op release - returns { ok: false } immediately
    failResult.release = async () => {
      return { ok: false };
    };

    // No-op extend - returns { ok: false } immediately
    failResult.extend = async () => {
      return { ok: false };
    };

    return failResult;
  }

  // Successful acquisition: create full disposable handle
  return createDisposableHandle(
    backend,
    result,
    key,
    onReleaseError,
    disposeTimeoutMs,
  );
}

/**
 * Optional sugar for fully-typed RAII without manual type narrowing.
 * Calls backend.acquire() and returns typed handle or failure.
 *
 * @param backend Backend instance
 * @param opts Acquisition options
 * @returns AsyncLock or failure - no type narrowing needed
 *
 * @example
 * ```typescript
 * // Option A: Standard (uses TypeScript's built-in narrowing)
 * await using lock = await backend.acquire({ key, ttlMs });
 * if (!lock.ok) return;
 * await lock.extend(5000); // TypeScript knows this is AsyncLock after ok check
 *
 * // Option B: Sugar (same narrowing, different API)
 * await using lock = await acquireHandle(backend, { key, ttlMs });
 * if (!lock.ok) return;
 * await lock.extend(5000); // Same narrowing behavior
 * ```
 */
export async function acquireHandle<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  opts: KeyOp & { ttlMs: number },
): Promise<AsyncLock<C> | { ok: false; reason: "locked" }> {
  const result = await backend.acquire(opts);

  if (!result.ok) {
    return result;
  }

  // Result is already decorated by backend, just return it
  // Type assertion safe here since we checked ok: true
  return result as AsyncLock<C>;
}
