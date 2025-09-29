// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Core type definitions for the SyncGuard distributed lock library.
 * Defines the backend interface, capabilities, and result types.
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
 * Fencing token: 19-digit zero-padded decimal string.
 * Format: "0000000000000000001"
 * Ordering: Lexicographic comparison (fenceA > fenceB)
 * Range: Redis signed 64-bit INCR limit (2^63-1 ≈ 9.2e18)
 */
export type Fence = string;

/**
 * Hash identifier for observability (SHA-256 truncated to 96 bits, 24 hex chars).
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
 * Debug variant with raw identifiers (via lookupDebug helper). SECURITY: Contains sensitive data.
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
 * Core lock configuration for the lock() helper.
 */
export interface LockConfig {
  /** Unique lock identifier */
  key: string;
  /** Lock TTL in milliseconds (default: 30000) */
  ttlMs?: number;
  /** Abort in-flight operations */
  signal?: AbortSignal;
  /** Error handler for background release failures */
  onReleaseError?: (
    error: Error,
    context: { lockId: string; key: string },
  ) => void;
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
   */
  acquire: (opts: KeyOp & { ttlMs: number }) => Promise<AcquireResult<C>>;

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
