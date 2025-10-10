// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { CollectionReference, Firestore } from "@google-cloud/firestore";
import {
  mapFirestoreConditions,
  mapToMutationResult,
} from "../../common/backend-semantics.js";
import {
  LockError,
  validateLockId,
  type ExtendResult,
  type LockOp,
} from "../../common/backend.js";
import { isLive, TIME_TOLERANCE_MS } from "../../common/time-predicates.js";
import { checkAbortedForTransaction, mapFirestoreError } from "../errors.js";
import type { FirestoreConfig, LockDocument } from "../types.js";

/**
 * Creates extend operation that atomically renews lock TTL via transaction.
 * @see specs/firestore-backend.md for transaction semantics
 */
export function createExtendOperation(
  db: Firestore,
  locksCollection: CollectionReference,
  config: FirestoreConfig,
) {
  return async (opts: LockOp & { ttlMs: number }): Promise<ExtendResult> => {
    try {
      validateLockId(opts.lockId);

      if (!Number.isInteger(opts.ttlMs) || opts.ttlMs <= 0) {
        throw new LockError(
          "InvalidArgument",
          "ttlMs must be a positive integer",
        );
      }

      const result = await db.runTransaction(async (trx) => {
        // Check for cancellation at start of transaction
        checkAbortedForTransaction(opts.signal);

        // Query by lockId index (assumes composite index exists: see specs/firestore-backend.md)
        const querySnapshot = await trx.get(
          locksCollection.where("lockId", "==", opts.lockId).limit(1),
        );

        // Check for cancellation after read
        checkAbortedForTransaction(opts.signal);

        const doc = querySnapshot.docs[0];
        const data = doc?.data() as LockDocument | undefined;

        // MUST capture nowMs inside transaction for authoritative client-time (ADR-010)
        // This ensures expiresAtMs is computed from the same time source used for liveness checks
        const nowMs = Date.now();

        const documentExists = !querySnapshot.empty;
        const ownershipValid = data?.lockId === opts.lockId;
        const isLockLive = data
          ? isLive(data.expiresAtMs, nowMs, TIME_TOLERANCE_MS)
          : false;

        // Map conditions to standard result codes for telemetry (see: common/backend-semantics.ts)
        const condition = mapFirestoreConditions({
          documentExists,
          ownershipValid,
          isLive: isLockLive,
        });

        if (condition === "succeeded") {
          // Check for cancellation before write
          checkAbortedForTransaction(opts.signal);

          // Compute new expiresAtMs from authoritative time captured inside transaction
          // NEVER pre-compute outside transaction to ensure time authority consistency
          const newExpiresAtMs = nowMs + opts.ttlMs;

          // Replace TTL entirely (not additive)
          await trx.update(doc!.ref, { expiresAtMs: newExpiresAtMs });
          return { ok: true as const, expiresAtMs: newExpiresAtMs };
        }

        return mapToMutationResult(condition);
      });

      return result as ExtendResult;
    } catch (error) {
      if (error instanceof LockError) {
        throw error;
      }
      throw mapFirestoreError(error);
    }
  };
}
