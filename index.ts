// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * SyncGuard - Distributed Lock Library
 *
 * Core exports for custom backend implementations and lock helper API.
 * See: specs/interface.md for complete API contracts and usage patterns.
 * See: specs/adrs.md for architectural decisions (telemetry, retry logic).
 */

// Core Types

export type {
  AcquireOk,
  AcquireResult,
  AcquisitionOptions,
  BackendCapabilities,
  ExtendResult,
  Fence,
  HashId,
  KeyLookup,
  KeyOp,
  LockBackend,
  LockConfig,
  LockEvent,
  LockInfo,
  LockInfoDebug,
  LockOp,
  OwnershipLookup,
  ReleaseResult,
  TelemetryOptions,
} from "./common/types.js";

// Configuration Constants

export {
  BACKEND_DEFAULTS,
  LOCK_DEFAULTS,
  MAX_KEY_LENGTH_BYTES,
} from "./common/constants.js";

// Core Functions and Classes

export { LockError } from "./common/errors.js";

export {
  normalizeAndValidateKey,
  validateLockId,
} from "./common/validation.js";

export { generateLockId, hashKey, makeStorageKey } from "./common/crypto.js";

// Primary lock API with automatic retry and cleanup
export { createAutoLock, lock } from "./common/auto-lock.js";

// Diagnostic helpers for lock inspection and ownership verification
export {
  getById,
  getByIdRaw,
  getByKey,
  getByKeyRaw,
  hasFence,
  lookupDebug,
  owns,
  sanitizeLockInfo,
} from "./common/helpers.js";

// Telemetry - Opt-in observability decorator (ADR-007)
export { withTelemetry } from "./common/telemetry.js";

// Time Predicates - Backend implementations use these for lock expiry checks

export {
  calculateRedisServerTimeMs,
  isLive,
  TIME_TOLERANCE_MS,
} from "./common/time-predicates.js";
