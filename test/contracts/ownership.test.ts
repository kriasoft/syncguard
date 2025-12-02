// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import type { LockBackend } from "../../common/types.js";
import { getAvailableBackends } from "../fixtures/backends.js";

describe("Ownership Verification (ADR-003)", async () => {
  const availableBackends = await getAvailableBackends();

  if (availableBackends.length === 0) {
    it.skip("No backends available", () => {});
    return;
  }

  for (const fixture of availableBackends) {
    describe(`${fixture.name}`, () => {
      let backend: LockBackend;
      let cleanup: () => Promise<void>;
      let teardown: () => Promise<void>;

      // TIME_TOLERANCE_MS is 1000ms, so lock expiry = TTL + 1000ms
      // Firestore is slower due to HTTP round-trips - use longer base timeouts
      const shortTtl = fixture.kind === "firestore" ? 2000 : 1000;
      // Sleep must exceed TTL + TIME_TOLERANCE_MS (1000ms) + network buffer
      const sleepBuffer = fixture.kind === "firestore" ? 4000 : 2500;
      // Firestore tests need longer timeout and retry for network variability
      const slowTestOpts =
        fixture.kind === "firestore" ? { timeout: 10000, retry: 2 } : {};

      beforeAll(async () => {
        const result = await fixture.setup();
        backend = result.createBackend();
        cleanup = result.cleanup;
        teardown = result.teardown;
      });

      beforeEach(async () => {
        await cleanup();
      });

      afterAll(async () => {
        await teardown();
      });

      it("should verify ownership explicitly in release operation", async () => {
        const key = "ownership:release:test";

        // Acquire a lock
        const result1 = await backend.acquire({ key, ttlMs: 30000 });
        expect(result1.ok).toBe(true);

        if (result1.ok) {
          // Try to release with a different valid lockId
          const fakeLockId = "abcdefghijklmnopqrstuv"; // Valid format, wrong owner
          const releaseResult = await backend.release({ lockId: fakeLockId });

          // Should fail due to explicit ownership verification
          expect(releaseResult.ok).toBe(false);

          // Original lock should still be held
          expect(await backend.isLocked({ key })).toBe(true);

          // Clean up with correct lockId
          await backend.release({ lockId: result1.lockId });
        }
      });

      it("should verify ownership explicitly in extend operation", async () => {
        const key = "ownership:extend:test";

        // Acquire a lock
        const result1 = await backend.acquire({ key, ttlMs: 30000 });
        expect(result1.ok).toBe(true);

        if (result1.ok) {
          // Try to extend with a different valid lockId (22 base64url chars)
          const fakeLockId = "eHh4eHh4eHh4eHh4eHh4eA"; // Valid format, wrong owner
          const extendResult = await backend.extend({
            lockId: fakeLockId,
            ttlMs: 60000,
          });

          // Should fail due to explicit ownership verification
          expect(extendResult.ok).toBe(false);

          // Original lock should still be held with original TTL
          expect(await backend.isLocked({ key })).toBe(true);

          // Clean up
          await backend.release({ lockId: result1.lockId });
        }
      });

      it("should prevent one lock holder from releasing another's lock", async () => {
        const key1 = "ownership:separate:lock1";
        const key2 = "ownership:separate:lock2";

        // Acquire two different locks
        const result1 = await backend.acquire({ key: key1, ttlMs: 30000 });
        const result2 = await backend.acquire({ key: key2, ttlMs: 30000 });

        expect(result1.ok).toBe(true);
        expect(result2.ok).toBe(true);

        if (result1.ok && result2.ok) {
          // Try to release lock1 with lock2's lockId
          const releaseResult = await backend.release({
            lockId: result2.lockId,
          });

          // This should succeed (releasing lock2)
          expect(releaseResult.ok).toBe(true);

          // Lock1 should still be held
          expect(await backend.isLocked({ key: key1 })).toBe(true);

          // Lock2 should be released
          expect(await backend.isLocked({ key: key2 })).toBe(false);

          // Clean up lock1
          await backend.release({ lockId: result1.lockId });
        }
      });

      it(
        "should prevent extending expired lock by another holder",
        async () => {
          const key = "ownership:extend-after-expire:test";

          // First lock with short TTL
          const result1 = await backend.acquire({ key, ttlMs: shortTtl });
          expect(result1.ok).toBe(true);

          if (result1.ok) {
            const lockId1 = result1.lockId;

            // Wait for it to expire (with generous buffer)
            await Bun.sleep(sleepBuffer);

            // Second acquisition should succeed
            const result2 = await backend.acquire({ key, ttlMs: 30000 });
            expect(result2.ok).toBe(true);

            if (result2.ok) {
              // Try to extend expired lock with original lockId
              const extendResult = await backend.extend({
                lockId: lockId1,
                ttlMs: 30000,
              });

              // Should fail - lock has expired and new owner acquired it
              expect(extendResult.ok).toBe(false);

              // Current lock should still be held by new owner
              expect(await backend.isLocked({ key })).toBe(true);

              // Clean up
              await backend.release({ lockId: result2.lockId });
            }
          }
        },
        slowTestOpts,
      );

      it("should verify ownership with correct lockId allows operations", async () => {
        const key = "ownership:correct:test";

        const result = await backend.acquire({ key, ttlMs: 30000 });
        expect(result.ok).toBe(true);

        if (result.ok) {
          // Extend with correct lockId should succeed
          const extendResult = await backend.extend({
            lockId: result.lockId,
            ttlMs: 40000,
          });
          expect(extendResult.ok).toBe(true);

          // Release with correct lockId should succeed
          const releaseResult = await backend.release({
            lockId: result.lockId,
          });
          expect(releaseResult.ok).toBe(true);

          // Lock should be released
          expect(await backend.isLocked({ key })).toBe(false);
        }
      });

      it("should handle concurrent ownership checks", async () => {
        const key = "ownership:concurrent:test";

        const result = await backend.acquire({ key, ttlMs: 30000 });
        expect(result.ok).toBe(true);

        if (result.ok) {
          const fakeLockId = "wrongLockIdValue1234ab"; // Valid format (22 chars)

          // Multiple concurrent attempts to release with wrong lockId
          const releases = await Promise.all([
            backend.release({ lockId: fakeLockId }),
            backend.release({ lockId: fakeLockId }),
            backend.release({ lockId: fakeLockId }),
          ]);

          // All should fail
          releases.forEach((result) => {
            expect(result.ok).toBe(false);
          });

          // Original lock should still be held
          expect(await backend.isLocked({ key })).toBe(true);

          // Correct release should succeed
          const correctRelease = await backend.release({
            lockId: result.lockId,
          });
          expect(correctRelease.ok).toBe(true);
        }
      });

      it("should verify ownership after lock extension", async () => {
        const key = "ownership:after-extend:test";

        const result = await backend.acquire({ key, ttlMs: 30000 });
        expect(result.ok).toBe(true);

        if (result.ok) {
          // Extend the lock
          const extendResult = await backend.extend({
            lockId: result.lockId,
            ttlMs: 40000,
          });
          expect(extendResult.ok).toBe(true);

          // Try to release with wrong lockId after extension
          const fakeLockId = "afterExtendWrongLock12"; // Valid format (22 chars)
          const wrongRelease = await backend.release({ lockId: fakeLockId });
          expect(wrongRelease.ok).toBe(false);

          // Original lockId should still work
          const correctRelease = await backend.release({
            lockId: result.lockId,
          });
          expect(correctRelease.ok).toBe(true);
        }
      });
    });
  }
});
