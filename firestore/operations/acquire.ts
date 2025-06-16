/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

import type { CollectionReference, Firestore } from "@google-cloud/firestore";
import type { LockConfig, LockResult } from "../../common/backend.js";
import { generateLockId, mergeLockConfig } from "../../common/backend.js";
import { withAcquireRetries } from "../retry.js";
import type { FirestoreConfig, LockDocument } from "../types.js";

/**
 * Creates an acquire operation for Firestore backend
 */
export function createAcquireOperation(
  db: Firestore,
  locksCollection: CollectionReference,
  config: FirestoreConfig,
) {
  return async (lockConfig: LockConfig): Promise<LockResult> => {
    const mergedConfig = mergeLockConfig(lockConfig);
    const lockId = generateLockId();
    const startTime = Date.now();

    try {
      const result = await withAcquireRetries(
        async () => {
          // Check timeout before starting transaction to avoid orphaned locks
          if (Date.now() - startTime > mergedConfig.timeoutMs) {
            return {
              acquired: false,
              reason: "Acquisition timeout before transaction",
            } as const;
          }

          const docRef = locksCollection.doc(mergedConfig.key);

          const transactionResult = await db.runTransaction(async (trx) => {
            const doc = await trx.get(docRef);
            const currentTime = Date.now();
            const expiresAt = currentTime + mergedConfig.ttlMs;

            // Final timeout check inside transaction before committing
            if (currentTime - startTime > mergedConfig.timeoutMs) {
              return {
                acquired: false,
                reason: "Acquisition timeout during transaction",
              } as const;
            }

            if (doc.exists) {
              const data = doc.data() as LockDocument;
              if (data.expiresAt > currentTime) {
                return {
                  acquired: false,
                  reason: "Lock already held",
                } as const;
              }
              // Lock exists but is expired - we can overwrite it atomically
            }

            const lockDocument: LockDocument = {
              lockId,
              expiresAt,
              createdAt: currentTime,
              key: mergedConfig.key,
            };

            // Use set() to atomically create or overwrite (including expired locks)
            trx.set(docRef, lockDocument);
            return { acquired: true, expiresAt } as const;
          });

          return transactionResult;
        },
        config,
        mergedConfig.timeoutMs,
      );

      if (result.acquired) {
        return {
          success: true,
          lockId,
          expiresAt: new Date(result.expiresAt!),
        };
      } else {
        return {
          success: false,
          error: result.reason || "Failed to acquire lock",
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      return {
        success: false,
        error: `Failed to acquire lock "${mergedConfig.key}": ${errorMessage}`,
      };
    }
  };
}
