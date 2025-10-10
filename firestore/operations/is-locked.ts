// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { CollectionReference, Firestore } from "@google-cloud/firestore";
import {
  checkAborted,
  type KeyOp,
  LockError,
  makeStorageKey,
  normalizeAndValidateKey,
} from "../../common/backend.js";
import { isLive, TIME_TOLERANCE_MS } from "../../common/time-predicates.js";
import { mapFirestoreError } from "../errors.js";
import type { FirestoreConfig, LockDocument } from "../types.js";

/**
 * Creates isLocked operation for Firestore backend.
 * Uses transactional cleanup with safety guard when enabled.
 * @see ../../common/time-predicates.ts for expiration logic
 */
export function createIsLockedOperation(
  db: Firestore,
  locksCollection: CollectionReference,
  config: FirestoreConfig,
) {
  return async (opts: KeyOp): Promise<boolean> => {
    try {
      // Check for cancellation before starting operation
      checkAborted(opts.signal);

      const normalizedKey = normalizeAndValidateKey(opts.key);

      const FIRESTORE_LIMIT_BYTES = 1500;
      const RESERVE_BYTES = 0; // No derived keys in Firestore

      const storageKey = makeStorageKey(
        "",
        normalizedKey,
        FIRESTORE_LIMIT_BYTES,
        RESERVE_BYTES,
      );
      const docRef = locksCollection.doc(storageKey);
      const doc = await docRef.get();

      // Check for cancellation after read
      checkAborted(opts.signal);

      if (!doc.exists) {
        return false;
      }

      const data = doc.data() as LockDocument;
      const nowMs = Date.now();

      if (!isLive(data.expiresAtMs, nowMs, TIME_TOLERANCE_MS)) {
        if (config.cleanupInIsLocked) {
          // 1s safety guard prevents race with concurrent extend operations
          const guardMs = 1000;
          if (nowMs - data.expiresAtMs > TIME_TOLERANCE_MS + guardMs) {
            // Fire-and-forget: non-blocking cleanup, swallow errors
            // Note: opts.signal intentionally not passed to background cleanup
            db.runTransaction(async (trx) => {
              const transactionDoc = await trx.get(docRef);
              if (transactionDoc.exists) {
                const transactionData = transactionDoc.data() as LockDocument;
                // Re-verify expiration in transaction to prevent races
                if (
                  !isLive(
                    transactionData.expiresAtMs,
                    nowMs,
                    TIME_TOLERANCE_MS + guardMs,
                  )
                ) {
                  await trx.delete(docRef);
                }
              }
            }).catch(() => {
              // Lock expires naturally if cleanup fails
            });
          }
        }
        return false;
      }

      return true;
    } catch (error) {
      if (error instanceof LockError) {
        throw error;
      }
      throw mapFirestoreError(error);
    }
  };
}
