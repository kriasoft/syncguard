// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { Firestore } from "@google-cloud/firestore";
import { lock } from "../common/auto-lock.js";
import type { AcquisitionOptions, LockConfig } from "../common/types.js";
import { createFirestoreBackend } from "./backend.js";
import type { FirestoreBackendOptions } from "./types.js";

/**
 * Creates distributed lock with Firestore backend
 * @param db - Firestore client instance
 * @param options - Retry, TTL, and collection config
 * @returns Auto-managed lock function (see: common/auto-lock.ts)
 */
export function createLock(
  db: Firestore,
  options: FirestoreBackendOptions = {},
) {
  const backend = createFirestoreBackend(db, options);
  return <T>(
    fn: () => Promise<T> | T,
    config: LockConfig & { acquisition?: AcquisitionOptions },
  ): Promise<T> => {
    return lock(backend, fn, config);
  };
}

// Re-exports for custom backend implementations
export { createFirestoreBackend } from "./backend.js";
export type {
  FirestoreBackendOptions,
  FirestoreConfig,
  LockDocument,
} from "./types.js";
