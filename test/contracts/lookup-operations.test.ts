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
import { LockError } from "../../common/errors.js";
import type { LockBackend } from "../../common/types.js";
import { getAvailableBackends } from "../fixtures/backends.js";

describe("Lookup Operations", async () => {
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

      it("should lookup lock by key and return sanitized data", async () => {
        const key = "lookup:by-key:test";

        // Acquire a lock
        const acquireResult = await backend.acquire({
          key,
          ttlMs: 30000,
        });
        expect(acquireResult.ok).toBe(true);

        if (acquireResult.ok) {
          // Test lookup operation
          const lookupResult = await backend.lookup({ key });
          expect(lookupResult).not.toBeNull();

          if (lookupResult) {
            // Verify sanitized data structure
            expect(typeof lookupResult.keyHash).toBe("string");
            expect(typeof lookupResult.lockIdHash).toBe("string");
            // Allow small timing differences between client and server time
            expect(
              Math.abs(lookupResult.expiresAtMs - acquireResult.expiresAtMs),
            ).toBeLessThan(100);
            expect(typeof lookupResult.acquiredAtMs).toBe("number");

            // Verify fence token exists if backend supports fencing
            if (backend.capabilities.supportsFencing) {
              expect("fence" in lookupResult).toBe(true);
              if ("fence" in lookupResult && "fence" in acquireResult) {
                expect(lookupResult.fence).toBe(acquireResult.fence);
              }
            }

            // Verify no raw data is included (sanitized)
            expect((lookupResult as any).key).toBeUndefined();
            expect((lookupResult as any).lockId).toBeUndefined();
          }

          // Clean up
          await backend.release({ lockId: acquireResult.lockId });
        }
      });

      it("should lookup lock by lockId (ownership check)", async () => {
        const key = "lookup:by-lockid:test";

        // Acquire a lock
        const acquireResult = await backend.acquire({
          key,
          ttlMs: 30000,
        });
        expect(acquireResult.ok).toBe(true);

        if (acquireResult.ok) {
          // Test ownership lookup
          const lookupResult = await backend.lookup({
            lockId: acquireResult.lockId,
          });
          expect(lookupResult).not.toBeNull();

          if (lookupResult) {
            // Verify sanitized data structure
            expect(typeof lookupResult.keyHash).toBe("string");
            expect(typeof lookupResult.lockIdHash).toBe("string");
            expect(
              Math.abs(lookupResult.expiresAtMs - acquireResult.expiresAtMs),
            ).toBeLessThan(100);
            expect(typeof lookupResult.acquiredAtMs).toBe("number");

            // Verify fence token exists if backend supports fencing
            if (backend.capabilities.supportsFencing) {
              expect("fence" in lookupResult).toBe(true);
              if ("fence" in lookupResult && "fence" in acquireResult) {
                expect(lookupResult.fence).toBe(acquireResult.fence);
              }
            }

            // Verify no raw data is included (sanitized)
            expect((lookupResult as any).key).toBeUndefined();
            expect((lookupResult as any).lockId).toBeUndefined();
          }

          // Clean up
          await backend.release({ lockId: acquireResult.lockId });
        }
      });

      it("should return null for non-existent lock (key lookup)", async () => {
        const lookupResult = await backend.lookup({
          key: "lookup:nonexistent:test",
        });
        expect(lookupResult).toBeNull();
      });

      it("should return null for non-existent lock (lockId lookup)", async () => {
        const lookupResult = await backend.lookup({
          lockId: "AAAAAAAAAAAAAAAAAAAAAA",
        }); // Valid format but non-existent
        expect(lookupResult).toBeNull();
      });

      it("should return null for expired lock", async () => {
        const key = "lookup:expired:test";

        // Acquire lock with short TTL
        const acquireResult = await backend.acquire({
          key,
          ttlMs: shortTtl,
        });
        expect(acquireResult.ok).toBe(true);

        if (acquireResult.ok) {
          // Wait for lock to expire (with generous buffer)
          await Bun.sleep(sleepBuffer);

          // Lookup should return null for expired lock
          const lookupResult = await backend.lookup({ key });
          expect(lookupResult).toBeNull();

          // Ownership lookup should also return null
          const ownershipResult = await backend.lookup({
            lockId: acquireResult.lockId,
          });
          expect(ownershipResult).toBeNull();
        }
      });

      it("should validate key before performing lookup", async () => {
        // Invalid keys should throw immediately without I/O
        await expect(backend.lookup({ key: "" })).rejects.toThrow(LockError);
        await expect(backend.lookup({ key: "x".repeat(600) })).rejects.toThrow(
          "exceeds maximum length",
        );
      });

      it("should validate lockId before performing lookup", async () => {
        // Invalid lockIds should throw immediately without I/O
        await expect(backend.lookup({ lockId: "" })).rejects.toThrow(
          "Invalid lockId format",
        );
        await expect(
          backend.lookup({ lockId: "invalid-lockid" }),
        ).rejects.toThrow("Invalid lockId format");
        await expect(backend.lookup({ lockId: "too-short" })).rejects.toThrow(
          "Invalid lockId format",
        );
        await expect(
          backend.lookup({ lockId: "this-is-way-too-long-for-valid-lockid" }),
        ).rejects.toThrow("Invalid lockId format");
      });

      it("should handle concurrent lookups on same key", async () => {
        const key = "lookup:concurrent:test";

        // Acquire a lock
        const acquireResult = await backend.acquire({
          key,
          ttlMs: 30000,
        });
        expect(acquireResult.ok).toBe(true);

        if (acquireResult.ok) {
          // Multiple concurrent lookups should all succeed
          const lookups = await Promise.all([
            backend.lookup({ key }),
            backend.lookup({ key }),
            backend.lookup({ key }),
          ]);

          // All lookups should return the same lock info
          lookups.forEach((result) => {
            expect(result).not.toBeNull();
            if (result) {
              expect(result.keyHash).toBe(lookups[0]!.keyHash);
              expect(result.lockIdHash).toBe(lookups[0]!.lockIdHash);
            }
          });

          await backend.release({ lockId: acquireResult.lockId });
        }
      });

      it("should handle lookup on multiple different keys", async () => {
        const keys = [
          "lookup:multi:key1",
          "lookup:multi:key2",
          "lookup:multi:key3",
        ];

        // Acquire locks on all keys
        const acquireResults = await Promise.all(
          keys.map((key) => backend.acquire({ key, ttlMs: 30000 })),
        );

        // All acquisitions should succeed
        acquireResults.forEach((result) => {
          expect(result.ok).toBe(true);
        });

        // Lookup all keys
        const lookupResults = await Promise.all(
          keys.map((key) => backend.lookup({ key })),
        );

        // All lookups should return lock info
        lookupResults.forEach((result, index) => {
          expect(result).not.toBeNull();
          if (
            result &&
            acquireResults[index]!.ok &&
            "fence" in acquireResults[index]!
          ) {
            if (backend.capabilities.supportsFencing && "fence" in result) {
              const acquireResult = acquireResults[index]!;
              if (acquireResult.ok && "fence" in acquireResult) {
                expect(result.fence).toBe(acquireResult.fence);
              }
            }
          }
        });

        // Clean up
        await Promise.all(
          acquireResults.map((result) => {
            if (result.ok) {
              return backend.release({ lockId: result.lockId });
            }
            return Promise.resolve({ ok: false as const });
          }),
        );
      });
    });
  }
});
