// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { FirestoreBackendOptions, FirestoreConfig } from "./types.js";

/**
 * Default configuration for Firestore backend.
 * @see specs/firestore.md
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
 * Merges user options with defaults.
 * @param options - User-provided Firestore configuration
 * @returns Complete Firestore backend configuration
 */
export function createFirestoreConfig(
  options: FirestoreBackendOptions = {},
): FirestoreConfig {
  return {
    collection: options.collection ?? FIRESTORE_DEFAULTS.collection,
    fenceCollection:
      options.fenceCollection ?? FIRESTORE_DEFAULTS.fenceCollection,
    cleanupInIsLocked:
      options.cleanupInIsLocked ?? FIRESTORE_DEFAULTS.cleanupInIsLocked,
  };
}
