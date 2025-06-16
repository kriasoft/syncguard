/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

import type { CollectionReference, Firestore } from "@google-cloud/firestore";
import { withRetries } from "../retry.js";
import type { FirestoreConfig, LockDocument } from "../types.js";

/**
 * Creates an extend operation for Firestore backend
 */
export function createExtendOperation(
  db: Firestore,
  locksCollection: CollectionReference,
  config: FirestoreConfig,
) {
  return async (lockId: string, ttl: number): Promise<boolean> => {
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

      // Use transaction with direct document access for atomic operation
      const result = await db.runTransaction(async (trx) => {
        // Use the exact document reference from the query to avoid TOCTOU issues
        const docRef = doc.ref;
        const currentDoc = await trx.get(docRef);

        if (!currentDoc.exists) {
          return false;
        }

        const currentData = currentDoc.data() as LockDocument;
        const currentTime = Date.now();

        // Verify ownership and that lock hasn't expired
        if (
          currentData.lockId !== lockId ||
          currentData.expiresAt <= currentTime
        ) {
          return false;
        }

        trx.update(docRef, {
          expiresAt: currentTime + ttl,
        });

        return true;
      });

      return result;
    }, config);
  };
}
