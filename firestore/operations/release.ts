/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

import type { CollectionReference, Firestore } from "@google-cloud/firestore";
import { withRetries } from "../retry.js";
import type { FirestoreConfig, LockDocument } from "../types.js";

/**
 * Creates a release operation for Firestore backend
 */
export function createReleaseOperation(
  db: Firestore,
  locksCollection: CollectionReference,
  config: FirestoreConfig,
) {
  return async (lockId: string): Promise<boolean> => {
    return withRetries(async () => {
      // First, find the document by querying for lockId to get the key
      const querySnapshot = await locksCollection
        .where("lockId", "==", lockId)
        .limit(1)
        .get();

      if (querySnapshot.empty) {
        return false;
      }

      const doc = querySnapshot.docs[0]!;
      const data = doc.data() as LockDocument;

      // Use transaction for atomic ownership verification and deletion
      const result = await db.runTransaction(async (trx) => {
        // Use the exact document reference from the query to avoid TOCTOU issues
        const docRef = doc.ref;
        const currentDoc = await trx.get(docRef);

        // Handle race condition: document might have been deleted between query and transaction
        if (!currentDoc.exists) {
          // Document was deleted between query and transaction - treat as success
          // since our lockId was found initially but document no longer exists
          return true;
        }

        const currentData = currentDoc.data() as LockDocument;

        // Verify ownership by lockId - this is critical for safety
        if (currentData.lockId !== lockId) {
          // Document exists but lockId changed - another lock took this key
          return false;
        }

        trx.delete(docRef);
        return true;
      });

      return result;
    }, config);
  };
}
