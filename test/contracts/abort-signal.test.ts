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

describe("AbortSignal Support", async () => {
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

      it("should respect pre-dispatch AbortSignal in acquire", async () => {
        const controller = new AbortController();
        const key = "abort:pre-dispatch:acquire";

        // Abort before calling
        controller.abort();

        try {
          await backend.acquire({
            key,
            ttlMs: 1000,
            signal: controller.signal,
          });
          throw new Error("Should have thrown LockError");
        } catch (error) {
          expect(error).toBeInstanceOf(LockError);
          if (error instanceof LockError) {
            expect(error.code).toBe("Aborted");
            expect(error.message).toContain("aborted");
          }
        }
      });

      it("should respect pre-dispatch AbortSignal in release", async () => {
        const controller = new AbortController();
        const key = "abort:pre-dispatch:release";

        // Acquire a lock first
        const result = await backend.acquire({
          key,
          ttlMs: 30000,
        });
        expect(result.ok).toBe(true);

        if (!result.ok) return;

        // Abort before release
        controller.abort();

        try {
          await backend.release({
            lockId: result.lockId,
            signal: controller.signal,
          });
          throw new Error("Should have thrown LockError");
        } catch (error) {
          expect(error).toBeInstanceOf(LockError);
          if (error instanceof LockError) {
            expect(error.code).toBe("Aborted");
          }
        }

        // Cleanup without signal
        await backend.release({ lockId: result.lockId });
      });

      it("should respect pre-dispatch AbortSignal in extend", async () => {
        const controller = new AbortController();
        const key = "abort:pre-dispatch:extend";

        // Acquire a lock first
        const result = await backend.acquire({
          key,
          ttlMs: 30000,
        });
        expect(result.ok).toBe(true);

        if (!result.ok) return;

        // Abort before extend
        controller.abort();

        try {
          await backend.extend({
            lockId: result.lockId,
            ttlMs: 2000,
            signal: controller.signal,
          });
          throw new Error("Should have thrown LockError");
        } catch (error) {
          expect(error).toBeInstanceOf(LockError);
          if (error instanceof LockError) {
            expect(error.code).toBe("Aborted");
          }
        }

        // Cleanup without signal
        await backend.release({ lockId: result.lockId });
      });

      it("should respect pre-dispatch AbortSignal in isLocked", async () => {
        const controller = new AbortController();
        const key = "abort:pre-dispatch:islocked";

        // Abort before calling
        controller.abort();

        try {
          await backend.isLocked({
            key,
            signal: controller.signal,
          });
          throw new Error("Should have thrown LockError");
        } catch (error) {
          expect(error).toBeInstanceOf(LockError);
          if (error instanceof LockError) {
            expect(error.code).toBe("Aborted");
          }
        }
      });

      it("should respect pre-dispatch AbortSignal in lookup", async () => {
        const controller = new AbortController();
        const key = "abort:pre-dispatch:lookup";

        // Abort before calling
        controller.abort();

        try {
          await backend.lookup({
            key,
            signal: controller.signal,
          });
          throw new Error("Should have thrown LockError");
        } catch (error) {
          expect(error).toBeInstanceOf(LockError);
          if (error instanceof LockError) {
            expect(error.code).toBe("Aborted");
          }
        }
      });

      it("should allow operations when signal is not aborted", async () => {
        const controller = new AbortController();
        const key = "abort:not-aborted:test";

        // Operations should succeed when signal is not aborted
        const result = await backend.acquire({
          key,
          ttlMs: 30000,
          signal: controller.signal,
        });
        expect(result.ok).toBe(true);

        if (!result.ok) return;

        const isLocked = await backend.isLocked({
          key,
          signal: controller.signal,
        });
        expect(isLocked).toBe(true);

        const lookupResult = await backend.lookup({
          key,
          signal: controller.signal,
        });
        expect(lookupResult).not.toBeNull();

        const extendResult = await backend.extend({
          lockId: result.lockId,
          ttlMs: 40000,
          signal: controller.signal,
        });
        expect(extendResult.ok).toBe(true);

        // Cleanup
        await backend.release({
          lockId: result.lockId,
          signal: controller.signal,
        });
      });

      it("should handle abort during mid-flight operations", async () => {
        const controller = new AbortController();
        const key = "abort:mid-flight:test";

        // Simulate aborting during operation
        setTimeout(() => controller.abort(), 50);

        const startTime = Date.now();

        try {
          await backend.acquire({
            key,
            ttlMs: 30000,
            signal: controller.signal,
          });
          // May succeed if abort happens after operation completes
        } catch (error) {
          const elapsed = Date.now() - startTime;
          // Should fail relatively quickly if aborted mid-flight
          expect(elapsed).toBeLessThan(500);
          expect(error).toBeInstanceOf(LockError);
          if (error instanceof LockError) {
            expect(error.code).toBe("Aborted");
          }
        }
      });

      it("should handle multiple operations with same AbortSignal", async () => {
        const controller = new AbortController();
        const key1 = "abort:multi:key1";
        const key2 = "abort:multi:key2";

        // Acquire locks before aborting
        const result1 = await backend.acquire({
          key: key1,
          ttlMs: 30000,
          signal: controller.signal,
        });
        const result2 = await backend.acquire({
          key: key2,
          ttlMs: 30000,
          signal: controller.signal,
        });

        expect(result1.ok).toBe(true);
        expect(result2.ok).toBe(true);

        if (!result1.ok || !result2.ok) return;

        // Abort the controller
        controller.abort();

        // Subsequent operations should all fail
        try {
          await backend.extend({
            lockId: result1.lockId,
            ttlMs: 40000,
            signal: controller.signal,
          });
          throw new Error("Should have thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(LockError);
        }

        try {
          await backend.isLocked({
            key: key1,
            signal: controller.signal,
          });
          throw new Error("Should have thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(LockError);
        }

        // Cleanup without signal
        await backend.release({ lockId: result1.lockId });
        await backend.release({ lockId: result2.lockId });
      });
    });
  }
});
