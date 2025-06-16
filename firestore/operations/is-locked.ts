/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

import type { CollectionReference } from "@google-cloud/firestore";
import { withRetries } from "../retry.js";
import type { FirestoreConfig, LockDocument } from "../types.js";

/**
 * Creates an isLocked operation for Firestore backend
 */
export function createIsLockedOperation(
  locksCollection: CollectionReference,
  config: FirestoreConfig,
) {
  return async (key: string): Promise<boolean> => {
    return withRetries(async () => {
      const docRef = locksCollection.doc(key);
      const doc = await docRef.get();

      if (!doc.exists) {
        return false;
      }

      const data = doc.data() as LockDocument;
      const currentTime = Date.now();

      if (data.expiresAt <= currentTime) {
        // Fire-and-forget cleanup of expired lock
        docRef.delete().catch(() => {
          // Ignore cleanup errors
        });
        return false;
      }

      return true;
    }, config);
  };
}
