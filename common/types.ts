// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Core type definitions for the SyncGuard distributed lock library.
 * Defines the backend interface, capabilities, and result types.
 *
 * For AsyncDisposable support, see common/disposable.ts
 */

// ============================================================================
// Backend Capabilities
// ============================================================================

/**
 * Backend capability declaration for type-safe feature detection.
 * Parameterizes result types for compile-time guarantees (e.g., fence presence).
 */
export interface BackendCapabilities {
  /** Whether backend generates monotonic fence tokens */
  supportsFencing: boolean;
  /** Time authority model: server (Redis) or client (Firestore) */
  timeAuthority: "server" | "client";
}

// ============================================================================
// Operation Parameter Types
// ============================================================================

/** Base params for key-based operations */
export type KeyOp = Readonly<{ key: string; signal?: AbortSignal }>;

/** Base params for lockId-based operations */
export type LockOp = Readonly<{ lockId: string; signal?: AbortSignal }>;

/** Key-based lookup (O(1) direct access) */
export type KeyLookup = {
  key: string;
  signal?: AbortSignal;
};

/** LockId-based lookup (reverse lookup + verification) */
export type OwnershipLookup = {
  lockId: string;
  signal?: AbortSignal;
};

// ============================================================================
// Fence Token Types
// ============================================================================

/**
 * Fencing token: 15-digit zero-padded decimal string (ADR-004).
 * Format: "000000000000001"
 * Ordering: Lexicographic comparison (fenceA > fenceB)
 * Range: 10^15 operations ≈ 31.7 years at 1M locks/sec
 * Precision: Full safety within Lua's 53-bit precision limit (2^53-1 ≈ 9.007e15)
 */
export type Fence = string;

/**
 * Hash identifier for observability (SHA-256 truncated to 96 bits, 24 hex chars).
 *
 * @see specs/interface.md#hash-identifier-format - Normative specification
 */
export type HashId = string;

// ============================================================================
// Result Types
// ============================================================================

/**
 * Successful acquire result. Fence included when backend supports fencing.
 */
export type AcquireOk<C extends BackendCapabilities> = {
  ok: true;
  lockId: string;
  expiresAtMs: number;
} & (C["supportsFencing"] extends true ? { fence: Fence } : {});

/**
 * Acquire result: success with lock details or contention indicator.
 */
export type AcquireResult<C extends BackendCapabilities> =
  | AcquireOk<C>
  | {
      ok: false;
      reason: "locked";
    };

/**
 * Decorated acquire result: includes disposal support for await using.
 * This is what backends actually return after decorateAcquireResult().
 *
 * Failed acquisitions include a no-op disposer for await using compatibility.
 * Successful acquisitions are AsyncLock<C> with full disposal handle methods.
 */
export type DecoratedAcquireResult<C extends BackendCapabilities> =
  | (AcquireOk<C> & {
      release(signal?: AbortSignal): Promise<ReleaseResult>;
      extend(ttlMs: number, signal?: AbortSignal): Promise<ExtendResult>;
      [Symbol.asyncDispose](): Promise<void>;
    })
  | ({ ok: false; reason: "locked" } & {
      release(): Promise<ReleaseResult>;
      extend(ttlMs: number): Promise<ExtendResult>;
      [Symbol.asyncDispose](): Promise<void>;
    });

/**
 * Release result: no distinction between expired/not-found.
 */
export type ReleaseResult = { ok: true } | { ok: false };

/**
 * Extend result: includes new expiry for heartbeat scheduling.
 */
export type ExtendResult = { ok: true; expiresAtMs: number } | { ok: false };

// ============================================================================
// Lock Information Types
// ============================================================================

/**
 * Sanitized lock info from lookup(). Hashed identifiers prevent accidental logging.
 *
 * @see specs/interface.md#lock-information-types - Normative specification
 */
export type LockInfo<C extends BackendCapabilities> = {
  /** SHA-256 hash of key (96-bit truncated) */
  keyHash: HashId;
  /** SHA-256 hash of lockId (96-bit truncated) */
  lockIdHash: HashId;
  /** Unix timestamp in milliseconds */
  expiresAtMs: number;
  /** Unix timestamp in milliseconds */
  acquiredAtMs: number;
} & (C["supportsFencing"] extends true ? { fence: Fence } : {});

/**
 * Debug variant with raw identifiers (via getByKeyRaw/getByIdRaw helpers). SECURITY: Contains sensitive data.
 *
 * @see specs/interface.md#lock-information-types - Normative specification
 */
export type LockInfoDebug<C extends BackendCapabilities> = LockInfo<C> & {
  /** Raw key for debugging */
  key: string;
  /** Raw lockId for debugging */
  lockId: string;
};

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Callback for release errors during automatic disposal (Symbol.asyncDispose).
 * Never called for domain outcomes (lock absent) - only for system errors.
 * Errors are normalized to Error instances before being passed to the callback.
 *
 * **IMPORTANT: Automatic Disposal Only**
 *
 * This callback is ONLY invoked during automatic disposal via `await using` syntax.
 * Manual `release()` and `extend()` calls throw errors directly and do NOT use this callback.
 * This design provides:
 * - Consistent error handling: Manual operations throw for actionable handling
 * - RAII safety: Automatic disposal is best-effort cleanup that never throws
 * - Predictable behavior: Users can rely on manual operations reporting errors immediately
 *
 * **CRITICAL: Disposal Error Handling**
 *
 * When using `using`/`await using`, disposal errors (including timeouts and cleanup
 * failures) are ONLY passed to this callback. The disposal process itself never throws
 * to avoid disrupting your application's control flow. This is your ONLY mechanism to
 * observe disposal failures without wrapping the entire block in a separate try/catch.
 *
 * **Error Handling Patterns:**
 *
 * 1. Simple logging:
 * ```typescript
 * await using lock = await backend.lock('key', {
 *   onReleaseError: (err, ctx) => console.error('Disposal failed', err, ctx)
 * });
 * ```
 *
 * 2. Centralized error tracking:
 * ```typescript
 * const globalErrorHandler: OnReleaseError = (err, ctx) => {
 *   logger.error('Lock release failed', { error: err, ...ctx });
 *   metrics.increment('lock.release.error', { source: ctx.source });
 * };
 * ```
 *
 * 3. Combine with telemetry for complete observability:
 * ```typescript
 * import { withTelemetry } from 'syncguard/common';
 *
 * const backend = withTelemetry(redisBackend, {
 *   onEvent: (event) => metrics.recordLockOperation(event)
 * });
 *
 * await using lock = await backend.lock('key', {
 *   onReleaseError: globalErrorHandler
 * });
 * ```
 *
 * @param error Normalized error that occurred during release (LockError or Error)
 * @param context Error context with lock identifiers and source (always "disposal")
 *
 * @see specs/interface.md#error-handling-patterns - Complete error handling guide
 */
export type OnReleaseError = (
  error: Error,
  context: {
    lockId: string;
    key: string;
    source: "disposal";
  },
) => void;

/**
 * Common backend configuration options.
 */
export interface BackendConfig {
  /**
   * Error handler for automatic disposal failures (via `await using`).
   * Not called for manual release() errors - those are thrown.
   *
   * **Important**: This is your only mechanism to observe disposal errors when using
   * `await using`. Disposal never throws to avoid disrupting control flow.
   *
   * Use cases:
   * - Logging disposal failures for observability
   * - Metrics/alerting on resource cleanup issues
   * - Debug mode error reporting
   *
   * @example
   * ```typescript
   * const backend = createRedisBackend(redis, {
   *   onReleaseError: (err, ctx) => {
   *     logger.error('Disposal failed', { error: err, ...ctx });
   *   }
   * });
   * ```
   *
   * @see OnReleaseError for error handling patterns
   * @see specs/interface.md#error-handling-patterns
   */
  onReleaseError?: OnReleaseError;

  /**
   * Timeout for automatic disposal operations in milliseconds.
   * When set, disposal will abort if the release operation exceeds this duration.
   *
   * **Default: undefined (no timeout)**
   *
   * Use cases:
   * - High-reliability systems needing guaranteed disposal responsiveness
   * - Unreliable network environments (distributed backends)
   * - Defense against backend client hangs
   *
   * **Note**: Most applications should rely on backend client timeouts instead:
   * - Redis: Configure socket timeout in client options
   * - PostgreSQL: Use statement_timeout or query_timeout
   * - Firestore: Configure timeout in client settings
   *
   * Only use this when you need disposal-specific timeout behavior independent
   * of general backend timeouts. Timeout errors are reported via onReleaseError
   * if configured.
   *
   * @example
   * ```typescript
   * const backend = createRedisBackend(redis, {
   *   disposeTimeoutMs: 5000, // Abort disposal after 5s
   *   onReleaseError: (err, ctx) => logger.warn('Disposal timeout', err, ctx)
   * });
   * ```
   */
  disposeTimeoutMs?: number;
}

/**
 * Core lock configuration for the lock() helper.
 */
export interface LockConfig {
  /** Unique lock identifier */
  key: string;
  /** Lock TTL in milliseconds (default: 30000) */
  ttlMs?: number;
  /** Abort in-flight operations */
  signal?: AbortSignal;
  /**
   * Error handler for background release failures during disposal.
   *
   * **Critical**: When using `await using`, this callback is your ONLY way to observe
   * disposal errors. Disposal never throws to avoid disrupting control flow.
   *
   * @example
   * ```typescript
   * await using lock = await backend.lock('key', {
   *   onReleaseError: (err, ctx) => {
   *     logger.error('Failed to release lock', { error: err, ...ctx });
   *   }
   * });
   * ```
   *
   * @see OnReleaseError for error handling patterns
   * @see specs/interface.md#error-handling-patterns
   */
  onReleaseError?: OnReleaseError;
}

/**
 * Acquisition retry configuration for lock() helper.
 */
export interface AcquisitionOptions {
  /** Max retry attempts (default: 10) */
  maxRetries?: number;
  /** Base retry delay in ms (default: 100) */
  retryDelayMs?: number;
  /** Backoff strategy (default: "exponential") */
  backoff?: "exponential" | "fixed";
  /** Jitter strategy (default: "equal") */
  jitter?: "equal" | "full" | "none";
  /** Hard timeout for acquisition loop in ms (default: 5000) */
  timeoutMs?: number;
  /** Abort the acquisition loop */
  signal?: AbortSignal;
}

// ============================================================================
// LockBackend Interface
// ============================================================================

/**
 * Core backend interface. Parameterized by capabilities for compile-time type safety.
 */
export interface LockBackend<
  C extends BackendCapabilities = BackendCapabilities,
> {
  /**
   * Acquire lock atomically. Returns lockId + fence (if supported) or contention.
   * Result includes disposal methods for `await using` support.
   */
  acquire: (
    opts: KeyOp & { ttlMs: number },
  ) => Promise<DecoratedAcquireResult<C>>;

  /**
   * Release lock by lockId. Returns success or false if absent.
   */
  release: (opts: LockOp) => Promise<ReleaseResult>;

  /**
   * Extend lock TTL by lockId. Returns new expiry or false if absent.
   */
  extend: (opts: LockOp & { ttlMs: number }) => Promise<ExtendResult>;

  /**
   * Check if key is locked (read-only, no side effects).
   */
  isLocked: (opts: KeyOp) => Promise<boolean>;

  /** Lookup by key (O(1) direct access) */
  lookup(opts: KeyLookup): Promise<LockInfo<C> | null>;
  /** Lookup by lockId (reverse lookup + verification) */
  lookup(opts: OwnershipLookup): Promise<LockInfo<C> | null>;

  /** Capability introspection */
  readonly capabilities: Readonly<C>;
}

// ============================================================================
// Telemetry Types
// ============================================================================

/**
 * Minimal event structure for telemetry. Hashes computed on-demand.
 *
 * @see specs/interface.md#telemetry-event-types - Normative specification
 */
export type LockEvent = {
  /** Operation type (acquire, release, extend, isLocked, lookup) */
  type: string;
  /** Key hash (computed only when telemetry active) */
  keyHash?: HashId;
  /** LockId hash (computed only when telemetry active) */
  lockIdHash?: HashId;
  /** Operation result */
  result: "ok" | "fail";
  /** Failure reason (best-effort from backend) */
  reason?: "expired" | "not-found" | "locked";
  /** Raw key (only when includeRaw allows) */
  key?: string;
  /** Raw lockId (only when includeRaw allows) */
  lockId?: string;
};

/**
 * Telemetry decorator configuration.
 */
export interface TelemetryOptions {
  /** Event callback */
  onEvent: (event: LockEvent) => void;
  /** Include raw identifiers in events (boolean or predicate) */
  includeRaw?: boolean | ((event: LockEvent) => boolean);
}
