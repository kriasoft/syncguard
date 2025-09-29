// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { CollectionReference, Firestore } from "@google-cloud/firestore";
import {
  type AcquireResult,
  formatFence,
  generateLockId,
  type KeyOp,
  LockError,
  makeStorageKey,
  normalizeAndValidateKey,
} from "../../common/backend.js";
import { isLive, TIME_TOLERANCE_MS } from "../../common/time-predicates.js";
import { mapFirestoreError } from "../errors.js";
import type {
  FenceCounterDocument,
  FirestoreCapabilities,
  FirestoreConfig,
  LockDocument,
} from "../types.js";

/**
 * Creates Firestore acquire operation with transactional fencing.
 * @see ../types.ts for document schemas
 */
export function createAcquireOperation(
  db: Firestore,
  locksCollection: CollectionReference,
  fenceCounterCollection: CollectionReference,
  config: FirestoreConfig,
) {
  return async (
    opts: KeyOp & { ttlMs: number },
  ): Promise<AcquireResult<FirestoreCapabilities>> => {
    try {
      normalizeAndValidateKey(opts.key);

      if (!Number.isInteger(opts.ttlMs) || opts.ttlMs <= 0) {
        throw new LockError(
          "InvalidArgument",
          "ttlMs must be a positive integer",
        );
      }

      const lockId = generateLockId();
      const normalizedKey = normalizeAndValidateKey(opts.key);
      // Firestore document ID limit: 1500 bytes
      const storageKey = makeStorageKey("", normalizedKey, 1500);
      const lockDoc = locksCollection.doc(storageKey);
      const fenceCounterDoc = fenceCounterCollection.doc(storageKey);

      // Transaction ensures atomic read-increment-write of fence counter with lock
      const result = await db.runTransaction(async (trx) => {
        // Firestore requirement: all reads before writes
        const currentLockDoc = await trx.get(lockDoc);
        const currentCounterDoc = await trx.get(fenceCounterDoc);

        const nowMs = Date.now();

        // Contention check: reject if unexpired lock exists
        if (currentLockDoc.exists) {
          const data = currentLockDoc.data() as LockDocument;
          if (isLive(data.expiresAtMs, nowMs, TIME_TOLERANCE_MS)) {
            return { ok: false as const, reason: "locked" as const };
          }
        }

        // BigInt fence counter: prevents precision loss at high values
        const currentFenceStr =
          currentCounterDoc.data()?.fence || "0000000000000000000";
        const currentFence = BigInt(currentFenceStr);
        const nextFence = currentFence + BigInt(1);

        // Operational monitoring: warn at 90% of max safe integer
        const warningThreshold = BigInt("9000000000000000000");
        if (nextFence > warningThreshold) {
          console.warn(
            `[SyncGuard] Fence counter approaching limit for key: ${opts.key}`,
          );
        }

        // Max safe integer for Firestore number type
        const maxValue = BigInt("9223372036854775807");
        if (nextFence > maxValue) {
          throw new LockError(
            "Internal",
            "Fence counter limit exceeded - contact operations to rotate key namespace",
          );
        }

        const nextFenceStr = formatFence(nextFence);
        const expiresAtMs = nowMs + opts.ttlMs;

        // Atomic write: update fence counter and create lock document
        const counterDocument: FenceCounterDocument = {
          fence: nextFenceStr,
          keyDebug: opts.key,
        };

        const lockDocument: LockDocument = {
          lockId,
          expiresAtMs,
          acquiredAtMs: nowMs,
          key: opts.key,
          fence: nextFenceStr,
        };

        await trx.set(fenceCounterDoc, counterDocument);
        await trx.set(lockDoc, lockDocument);

        return { ok: true as const, lockId, expiresAtMs, fence: nextFenceStr };
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
