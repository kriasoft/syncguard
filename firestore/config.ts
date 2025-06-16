/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

import type { FirestoreBackendOptions, FirestoreConfig } from "./types.js";

/**
 * Merges user options with default Firestore backend configuration
 */
export function createFirestoreConfig(
  options: FirestoreBackendOptions = {},
): FirestoreConfig {
  return {
    collection: "locks",
    retryDelayMs: 100,
    maxRetries: 10,
    ...options,
  };
}
