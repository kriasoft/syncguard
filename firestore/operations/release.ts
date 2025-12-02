// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { CollectionReference, Firestore } from "@google-cloud/firestore";
import {
  mapFirestoreConditions,
  mapToMutationResult,
  FAILURE_REASON,
} from "../../common/backend-semantics.js";
import {
  LockError,
  validateLockId,
  type LockOp,
  type ReleaseResult,
} from "../../common/backend.js";
import { isLive, TIME_TOLERANCE_MS } from "../../common/time-predicates.js";
import { checkAbortedForTransaction, mapFirestoreError } from "../errors.js";
import type { FirestoreConfig, LockDocument } from "../types.js";

/**
 * Creates Firestore release operation with atomic transaction and ownership verification.
 *
 * **Implementation Pattern:**
 * - Atomic transaction: Query by lockId → verify ownership → delete document
 * - TOCTOU protection: All steps within single `runTransaction()` (ADR-003, interface.md)
 * - Ownership verification: Explicit `data.lockId === opts.lockId` check (ADR-003)
 * - AbortSignal: Manual cancellation checks via `checkAbortedForTransaction()` at strategic points
 *
 * @remarks
 * Omits `.limit(1)` to detect duplicate lockIds (ADR-014). Expired duplicates cleaned,
 * live duplicates fail safely.
 *
 * @see docs/specs/interface.md#release-operation-requirements - Normative TOCTOU and ownership requirements
 * @see docs/specs/firestore-backend.md#release-operation-requirements - Firestore transaction pattern
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
        // Check for cancellation at start of transaction
        checkAbortedForTransaction(opts.signal);

        // Query by lockId index without .limit(1) for duplicate detection (ADR-014)
        const querySnapshot = await trx.get(
          locksCollection.where("lockId", "==", opts.lockId),
        );

        // Duplicate detection (ADR-014): log + cleanup expired, fail-safe on live
        if (querySnapshot.docs.length > 1) {
          console.warn(
            `[syncguard] Duplicate lockId detected in release: ${opts.lockId} (${querySnapshot.docs.length} documents)`,
          );

          const nowMs = Date.now();
          const expiredDocs = querySnapshot.docs.filter((doc) => {
            const data = doc.data() as LockDocument;
            return !isLive(data.expiresAtMs, nowMs, TIME_TOLERANCE_MS);
          });

          if (expiredDocs.length > 0) {
            await Promise.all(expiredDocs.map((d) => trx.delete(d.ref)));
          }

          // Fail-safe: abort if multiple live locks exist (ambiguous state)
          const liveCount = querySnapshot.docs.length - expiredDocs.length;
          if (liveCount > 1) {
            return { ok: false };
          }
        }

        // Check for cancellation after read
        checkAbortedForTransaction(opts.signal);

        const doc = querySnapshot.docs[0];
        const data = doc?.data() as LockDocument | undefined;
        const nowMs = Date.now();

        // Evaluate preconditions: document exists, ownership valid, lock live
        const documentExists = !querySnapshot.empty;
        const ownershipValid = data?.lockId === opts.lockId;
        const isLockLive = data
          ? isLive(data.expiresAtMs, nowMs, TIME_TOLERANCE_MS)
          : false;

        // Map to standard mutation result (see: common/backend-semantics.ts)
        const condition = mapFirestoreConditions({
          documentExists,
          ownershipValid,
          isLive: isLockLive,
        });

        if (condition === "succeeded") {
          // Check for cancellation before write
          checkAbortedForTransaction(opts.signal);
          await trx.delete(doc!.ref);
        }

        const mutationResult = mapToMutationResult(condition);
        // Public API returns simplified result, reason attached for telemetry only (ADR-007)
        const result: ReleaseResult = { ok: mutationResult.ok };
        if (!mutationResult.ok && mutationResult.reason) {
          (result as any)[FAILURE_REASON] = { reason: mutationResult.reason };
        }
        return result;
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
