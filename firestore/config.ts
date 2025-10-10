// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import { LockError } from "../common/errors.js";
import type { FirestoreBackendOptions, FirestoreConfig } from "./types.js";

/**
 * Default configuration for Firestore backend.
 * @see specs/firestore-backend.md
 */
export const FIRESTORE_DEFAULTS = {
  /** Collection name for lock documents */
  collection: "locks",
  /** Collection name for fencing token counters */
  fenceCollection: "fence_counters",
  /** Cleanup expired locks in isLocked() - disabled for O(1) performance */
  cleanupInIsLocked: false,
} as const;

/**
 * Merges user options with defaults and validates configuration.
 * @param options - User-provided Firestore configuration
 * @returns Complete Firestore backend configuration
 * @throws {LockError} If fenceCollection equals collection (prevents accidental fence counter deletion)
 */
export function createFirestoreConfig(
  options: FirestoreBackendOptions = {},
): FirestoreConfig {
  const collection = options.collection ?? FIRESTORE_DEFAULTS.collection;
  const fenceCollection =
    options.fenceCollection ?? FIRESTORE_DEFAULTS.fenceCollection;

  // CRITICAL: Prevent fence counter deletion by ensuring separate collections
  // Per specs/firestore-backend.md: Fence counters MUST be independent of lock lifecycle
  if (collection === fenceCollection) {
    throw new LockError(
      "InvalidArgument",
      `fenceCollection must be different from collection to prevent accidental fence counter deletion (both set to: ${collection})`,
    );
  }

  return {
    collection,
    fenceCollection,
    cleanupInIsLocked:
      options.cleanupInIsLocked ?? FIRESTORE_DEFAULTS.cleanupInIsLocked,
  };
}
