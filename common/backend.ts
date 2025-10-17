// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Core module exports for LockBackend implementations.
 * Import from `syncguard/common` to build custom backends.
 *
 * @see specs/interface.md - LockBackend API contracts
 */

// Export createAutoLock for internal use by backend modules only
export { createAutoLock, lock } from "./auto-lock.js";
export * from "./config.js";
export * from "./constants.js";
export * from "./crypto.js";
export * from "./disposable.js";
export * from "./errors.js";
export * from "./helpers.js";
export * from "./telemetry.js";
export * from "./types.js";
export * from "./validation.js";
