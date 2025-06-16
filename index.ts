/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

/**
 * D-Lock - Distributed Lock Library
 *
 * Core exports for custom backend implementations
 */

export type {
  LockBackend,
  LockConfig,
  LockErrorCode,
  LockFunction,
  LockResult,
  MergedLockConfig,
} from "./common/backend.js";

export {
  DEFAULT_CONFIG,
  LockError,
  LockErrorCodes,
  createLock,
  delay,
  generateLockId,
  mergeLockConfig,
} from "./common/backend.js";
