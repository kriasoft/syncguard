/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

import type { Firestore } from "@google-cloud/firestore";
import type { LockFunction } from "../common/backend.js";
import { createLock as createBaseLock } from "../common/backend.js";
import { createFirestoreBackend } from "./backend.js";
import type { FirestoreBackendOptions } from "./types.js";

/**
 * Creates a distributed lock function using Firestore backend
 * @param db Firestore instance
 * @param options Backend-specific configuration options
 * @returns Lock function with automatic and manual operations
 */
export function createLock(
  db: Firestore,
  options: FirestoreBackendOptions = {},
): LockFunction {
  const backend = createFirestoreBackend(db, options);
  return createBaseLock(backend);
}

// Re-export types and backend for advanced usage
export { createFirestoreBackend } from "./backend.js";
export type {
  FirestoreBackendOptions,
  FirestoreConfig,
  LockDocument,
} from "./types.js";
