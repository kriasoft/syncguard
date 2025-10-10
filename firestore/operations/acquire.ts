// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { CollectionReference, Firestore } from "@google-cloud/firestore";
import {
  type AcquireResult,
  checkAborted,
  FENCE_THRESHOLDS,
  formatFence,
  generateLockId,
  type KeyOp,
  LockError,
  logFenceWarning,
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
      // No reserve needed - each doc ID is independent (no derived suffixes like Redis)
      const FIRESTORE_LIMIT_BYTES = 1500;
      const RESERVE_BYTES = 0;

      // ADR-006: Two-step fence key generation for consistent hash mapping
      const baseKey = makeStorageKey(
        "",
        normalizedKey,
        FIRESTORE_LIMIT_BYTES,
        RESERVE_BYTES,
      );
      const fenceDocId = makeStorageKey(
        "",
        `fence:${baseKey}`,
        FIRESTORE_LIMIT_BYTES,
        RESERVE_BYTES,
      );
      const lockDoc = locksCollection.doc(baseKey);
      const fenceCounterDoc = fenceCounterCollection.doc(fenceDocId);

      // Transaction ensures atomic read-increment-write of fence counter with lock
      const result = await db.runTransaction(async (trx) => {
        // Check for cancellation before starting transaction work
        checkAborted(opts.signal);

        // Firestore requirement: all reads before writes
        const currentLockDoc = await trx.get(lockDoc);
        const currentCounterDoc = await trx.get(fenceCounterDoc);

        // Check for cancellation after reads
        checkAborted(opts.signal);

        // MUST capture nowMs inside transaction for authoritative client-time (ADR-010)
        // This ensures expiresAtMs is computed from the same time source used for liveness checks
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
          currentCounterDoc.data()?.fence || "000000000000000";
        const currentFence = BigInt(currentFenceStr);
        const nextFence = currentFence + BigInt(1);

        // Overflow enforcement (ADR-004): throw at FENCE_THRESHOLDS.MAX
        const overflowLimit = BigInt(FENCE_THRESHOLDS.MAX);
        if (nextFence > overflowLimit) {
          throw new LockError(
            "Internal",
            `Fence counter overflow - exceeded operational limit (${FENCE_THRESHOLDS.MAX})`,
            { key: opts.key },
          );
        }

        // Operational monitoring: warn at FENCE_THRESHOLDS.WARN using shared utility
        const warningThreshold = BigInt(FENCE_THRESHOLDS.WARN);
        if (nextFence > warningThreshold) {
          logFenceWarning(nextFence.toString(), opts.key);
        }

        const nextFenceStr = formatFence(nextFence);

        // Compute expiresAtMs from authoritative time captured inside transaction
        // NEVER pre-compute outside transaction to ensure time authority consistency
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

        // Check for cancellation before writes
        checkAborted(opts.signal);

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
