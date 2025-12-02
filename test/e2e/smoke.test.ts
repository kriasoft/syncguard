// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Smoke tests for SyncGuard core functionality.
 *
 * Quick sanity checks that verify the critical paths are working across
 * all backends. Run these tests to ensure the library is functioning
 * correctly after installation or before deployment.
 *
 * Tests:
 * - Basic lock acquire/release cycle
 * - High-level createLock() API
 * - Lock contention (mutual exclusion)
 * - TTL expiration
 * - Fence token generation
 * - AsyncDisposable pattern
 *
 * Run with: bun test test/e2e/smoke.test.ts
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { lock as lockWithBackend } from "../../common/auto-lock.js";
import type { LockBackend } from "../../common/types.js";
import { getAvailableBackends } from "../fixtures/backends.js";

describe("Smoke Tests", async () => {
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
      // Firestore acquisition settings: longer timeout due to emulator latency
      const firestoreAcquisitionOpts =
        fixture.kind === "firestore"
          ? { timeoutMs: 10000, retryDelayMs: 100 }
          : { timeoutMs: 2000, retryDelayMs: 10 };

      beforeAll(async () => {
        const setup = await fixture.setup();
        backend = setup.createBackend() as LockBackend;
        cleanup = setup.cleanup;
        teardown = setup.teardown;
      });

      beforeEach(async () => {
        await cleanup();
      });

      afterAll(async () => {
        await teardown();
      });

      // Core lock lifecycle
      it("acquires and releases a lock", async () => {
        const key = "smoke:lifecycle";

        const result = await backend.acquire({ key, ttlMs: 30000 });
        expect(result.ok).toBe(true);

        if (result.ok) {
          expect(result.lockId).toBeDefined();
          expect(await backend.isLocked({ key })).toBe(true);

          const released = await backend.release({ lockId: result.lockId });
          expect(released.ok).toBe(true);
          expect(await backend.isLocked({ key })).toBe(false);
        }
      });

      // High-level API with callback
      it("executes callback with automatic lock management", async () => {
        const key = "smoke:callback";
        let executed = false;

        const result = await lockWithBackend(
          backend,
          async () => {
            executed = true;
            expect(await backend.isLocked({ key })).toBe(true);
            return "done";
          },
          { key, ttlMs: 30000 },
        );

        expect(executed).toBe(true);
        expect(result).toBe("done");
        expect(await backend.isLocked({ key })).toBe(false);
      });

      // Mutual exclusion
      it(
        "prevents concurrent access to same resource",
        async () => {
          const key = "smoke:mutex";
          const events: string[] = [];

          const first = lockWithBackend(
            backend,
            async () => {
              events.push("first:start");
              await Bun.sleep(50);
              events.push("first:end");
            },
            { key, ttlMs: 30000 },
          );

          await Bun.sleep(10);

          const second = lockWithBackend(
            backend,
            async () => {
              events.push("second:start");
              await Bun.sleep(10);
              events.push("second:end");
            },
            {
              key,
              ttlMs: 30000,
              acquisition: firestoreAcquisitionOpts,
            },
          );

          await Promise.all([first, second]);

          // Second must wait for first to complete
          expect(events.indexOf("first:end")).toBeLessThan(
            events.indexOf("second:start"),
          );
        },
        slowTestOpts,
      );

      // TTL expiration
      it(
        "expires lock after TTL",
        async () => {
          const key = "smoke:ttl";

          const result = await backend.acquire({ key, ttlMs: shortTtl });
          expect(result.ok).toBe(true);

          if (result.ok) {
            expect(await backend.isLocked({ key })).toBe(true);
            // Sleep must exceed TTL + TIME_TOLERANCE_MS (1000ms)
            await Bun.sleep(sleepBuffer);
            expect(await backend.isLocked({ key })).toBe(false);
          }
        },
        slowTestOpts,
      );

      // Fence token
      it("generates monotonically increasing fence tokens", async () => {
        const key = "smoke:fence";
        const fences: string[] = [];

        for (let i = 0; i < 3; i++) {
          const result = await backend.acquire({ key, ttlMs: 30000 });
          expect(result.ok).toBe(true);

          if (result.ok) {
            const fence = (result as { fence?: string }).fence;
            expect(fence).toMatch(/^\d{15}$/);
            fences.push(fence!);
            await backend.release({ lockId: result.lockId });
          }
        }

        // Verify monotonicity
        for (let i = 1; i < fences.length; i++) {
          expect(fences[i]! > fences[i - 1]!).toBe(true);
        }
      });

      // Lock extension
      it("extends lock TTL", async () => {
        const key = "smoke:extend";

        const result = await backend.acquire({ key, ttlMs: 200 });
        expect(result.ok).toBe(true);

        if (result.ok) {
          await Bun.sleep(100);

          const extended = await backend.extend({
            lockId: result.lockId,
            ttlMs: 500,
          });
          expect(extended.ok).toBe(true);

          // Wait past original TTL
          await Bun.sleep(150);

          // Lock should still be held
          expect(await backend.isLocked({ key })).toBe(true);

          await backend.release({ lockId: result.lockId });
        }
      });

      // AsyncDisposable pattern
      it("releases lock via AsyncDisposable", async () => {
        const key = "smoke:disposable";

        {
          await using handle = await backend.acquire({ key, ttlMs: 30000 });
          expect(handle.ok).toBe(true);

          if (handle.ok) {
            expect(await backend.isLocked({ key })).toBe(true);
          }
        }

        // Lock released when scope exits
        expect(await backend.isLocked({ key })).toBe(false);
      });

      // Error handling: release even on callback error
      it("releases lock when callback throws", async () => {
        const key = "smoke:error";

        try {
          await lockWithBackend(
            backend,
            async () => {
              throw new Error("test error");
            },
            { key, ttlMs: 30000 },
          );
          expect(true).toBe(false);
        } catch (e) {
          expect((e as Error).message).toBe("test error");
        }

        expect(await backend.isLocked({ key })).toBe(false);
      });

      // Lookup operations
      it("looks up lock by key", async () => {
        const key = "smoke:lookup";

        const result = await backend.acquire({ key, ttlMs: 30000 });
        expect(result.ok).toBe(true);

        if (result.ok) {
          const info = await backend.lookup({ key });
          expect(info).not.toBeNull();

          if (info) {
            expect(info.keyHash).toBeDefined();
            expect(info.lockIdHash).toBeDefined();
            expect(info.expiresAtMs).toBeGreaterThan(Date.now());
          }

          await backend.release({ lockId: result.lockId });
        }
      });
    });
  }
});
