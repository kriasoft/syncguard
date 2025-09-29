// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { CollectionReference, Firestore } from "@google-cloud/firestore";
import {
  mapFirestoreConditions,
  mapToMutationResult,
} from "../../common/backend-semantics.js";
import {
  type LockOp,
  type ReleaseResult,
  LockError,
  validateLockId,
} from "../../common/backend.js";
import { isLive, TIME_TOLERANCE_MS } from "../../common/time-predicates.js";
import { mapFirestoreError } from "../errors.js";
import type { FirestoreConfig, LockDocument } from "../types.js";

/**
 * Creates release operation using Firestore transaction for atomic ownership check + delete.
 * @see ../../common/backend-semantics.ts for condition mapping
 */
export function createReleaseOperation(
  db: Firestore,
  locksCollection: CollectionReference,
  config: FirestoreConfig,
) {
  return async (opts: LockOp): Promise<ReleaseResult> => {
    try {
      validateLockId(opts.lockId);

      const result = await db.runTransaction(async (trx) => {
        // Query lockId index for O(1) lookup
        const querySnapshot = await trx.get(
          locksCollection.where("lockId", "==", opts.lockId).limit(1),
        );

        const doc = querySnapshot.docs[0];
        const data = doc?.data() as LockDocument | undefined;
        const nowMs = Date.now();

        // Evaluate preconditions for ownership + liveness check
        const documentExists = !querySnapshot.empty;
        const ownershipValid = data?.lockId === opts.lockId;
        const isLockLive = data
          ? isLive(data.expiresAtMs, nowMs, TIME_TOLERANCE_MS)
          : false;

        // Map to standard mutation result (succeeded/expired/not_found)
        const condition = mapFirestoreConditions({
          documentExists,
          ownershipValid,
          isLive: isLockLive,
        });

        if (condition === "succeeded") {
          await trx.delete(doc!.ref);
        }

        return mapToMutationResult(condition);
      });

      return result;
    } catch (error) {
      if (error instanceof LockError) {
        throw error;
      }
      throw mapFirestoreError(error);
    }
  };
}
