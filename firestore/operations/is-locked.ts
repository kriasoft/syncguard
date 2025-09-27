/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

import type { CollectionReference, Firestore } from "@google-cloud/firestore";
import { withRetries } from "../retry.js";
import type { FirestoreConfig, LockDocument } from "../types.js";

/**
 * Creates an isLocked operation for Firestore backend
 */
export function createIsLockedOperation(
  db: Firestore,
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
        // Use atomic transaction for cleanup to prevent race conditions
        try {
          await db.runTransaction(async (trx) => {
            const transactionDoc = await trx.get(docRef);
            if (transactionDoc.exists) {
              const transactionData = transactionDoc.data() as LockDocument;
              // Double-check expiration within transaction
              if (transactionData.expiresAt <= currentTime) {
                trx.delete(docRef);
              }
            }
          });
        } catch {
          // Ignore cleanup errors - lock will eventually be cleaned up by other operations
        }
        return false;
      }

      return true;
    }, config);
  };
}
