// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Unit tests for auto-lock retry logic
 *
 * Tests the lock() function's retry behavior including:
 * - Exponential and fixed backoff
 * - Jitter strategies (equal, full, none)
 * - Timeout handling
 * - AbortSignal support
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { lock } from "../../../common/auto-lock.js";
import { decorateAcquireResult } from "../../../common/disposable.js";
import { LockError } from "../../../common/errors.js";
import type {
  AcquireResult,
  BackendCapabilities,
  LockBackend,
} from "../../../common/types.js";

type TestCapabilities = BackendCapabilities & { supportsFencing: true };

describe("lock() retry behavior", () => {
  let mockBackend: LockBackend<TestCapabilities>;
  let acquireAttempts: number;

  const testCapabilities: TestCapabilities = {
    supportsFencing: true,
    timeAuthority: "server",
  };

  beforeEach(() => {
    acquireAttempts = 0;

    const mockBackendOps = {
      release: mock(async () => ({ ok: true as const })),
      extend: mock(async () => ({
        ok: true as const,
        expiresAtMs: Date.now() + 30000,
      })),
    };

    mockBackend = {
      acquire: mock(async () => {
        acquireAttempts++;
        const result: AcquireResult<TestCapabilities> = {
          ok: true,
          lockId: "test-lock-id",
          expiresAtMs: Date.now() + 30000,
          fence: "000000000000001",
        };
        return decorateAcquireResult(mockBackendOps, result, "test-key");
      }),
      release: mockBackendOps.release,
      extend: mockBackendOps.extend,
      isLocked: mock(async () => false),
      lookup: mock(async () => null),
      capabilities: testCapabilities,
    };
  });

  describe("successful acquisition", () => {
    it("should acquire lock and execute function on first attempt", async () => {
      const result = await lock(mockBackend, async () => "success", {
        key: "test-key",
        ttlMs: 30000,
      });

      expect(result).toBe("success");
      expect(acquireAttempts).toBe(1);
    });

    it("should release lock after function execution", async () => {
      await lock(mockBackend, async () => "success", {
        key: "test-key",
        ttlMs: 30000,
      });

      expect(mockBackend.release).toHaveBeenCalledWith({
        lockId: "test-lock-id",
        signal: undefined,
      });
    });

    it("should use custom ttlMs", async () => {
      await lock(mockBackend, async () => "success", {
        key: "test-key",
        ttlMs: 60000,
      });

      expect(mockBackend.acquire).toHaveBeenCalledWith({
        key: "test-key",
        ttlMs: 60000,
        signal: undefined,
      });
    });
  });

  describe("retry on contention", () => {
    it("should retry when lock is contended", async () => {
      let calls = 0;
      const mockBackendOps = {
        release: mock(async () => ({ ok: true as const })),
        extend: mock(async () => ({
          ok: true as const,
          expiresAtMs: Date.now() + 30000,
        })),
      };

      (mockBackend.acquire as ReturnType<typeof mock>).mockImplementation(
        async () => {
          calls++;
          if (calls < 3) {
            return { ok: false, reason: "locked" };
          }
          const result: AcquireResult<TestCapabilities> = {
            ok: true,
            lockId: "test-lock-id",
            expiresAtMs: Date.now() + 30000,
            fence: "000000000000001",
          };
          return decorateAcquireResult(mockBackendOps, result, "test-key");
        },
      );

      const result = await lock(mockBackend, async () => "success", {
        key: "test-key",
        ttlMs: 30000,
        acquisition: {
          maxRetries: 5,
          retryDelayMs: 10, // Fast for tests
          timeoutMs: 5000,
        },
      });

      expect(result).toBe("success");
      expect(calls).toBe(3); // Failed twice, succeeded on third
    });

    it("should throw AcquisitionTimeout when max retries exceeded", async () => {
      (mockBackend.acquire as ReturnType<typeof mock>).mockResolvedValue({
        ok: false,
        reason: "locked",
      });

      await expect(
        lock(mockBackend, async () => "success", {
          key: "test-key",
          ttlMs: 30000,
          acquisition: {
            maxRetries: 2,
            retryDelayMs: 1,
            timeoutMs: 5000,
          },
        }),
      ).rejects.toThrow(LockError);

      await expect(
        lock(mockBackend, async () => "success", {
          key: "test-key",
          ttlMs: 30000,
          acquisition: {
            maxRetries: 2,
            retryDelayMs: 1,
            timeoutMs: 5000,
          },
        }),
      ).rejects.toThrow(/Failed to acquire lock/);
    });

    it("should throw AcquisitionTimeout when timeout exceeded", async () => {
      (mockBackend.acquire as ReturnType<typeof mock>).mockResolvedValue({
        ok: false,
        reason: "locked",
      });

      try {
        await lock(mockBackend, async () => "success", {
          key: "test-key",
          ttlMs: 30000,
          acquisition: {
            maxRetries: 1000, // High limit
            retryDelayMs: 100,
            timeoutMs: 50, // Very short timeout
          },
        });
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(LockError);
        expect((error as LockError).code).toBe("AcquisitionTimeout");
      }
    });
  });

  describe("backoff strategies", () => {
    it("should support fixed backoff", async () => {
      let delays: number[] = [];
      const originalDateNow = Date.now;
      let mockTime = Date.now();

      // Track delay times
      let calls = 0;
      const mockBackendOps = {
        release: mock(async () => ({ ok: true as const })),
        extend: mock(async () => ({
          ok: true as const,
          expiresAtMs: mockTime + 30000,
        })),
      };

      (mockBackend.acquire as ReturnType<typeof mock>).mockImplementation(
        async () => {
          calls++;
          if (calls < 4) {
            return { ok: false, reason: "locked" };
          }
          const result: AcquireResult<TestCapabilities> = {
            ok: true,
            lockId: "test-lock-id",
            expiresAtMs: mockTime + 30000,
            fence: "000000000000001",
          };
          return decorateAcquireResult(mockBackendOps, result, "test-key");
        },
      );

      await lock(mockBackend, async () => "success", {
        key: "test-key",
        ttlMs: 30000,
        acquisition: {
          maxRetries: 10,
          retryDelayMs: 10,
          timeoutMs: 5000,
          backoff: "fixed",
          jitter: "none",
        },
      });

      expect(calls).toBe(4);
    });

    it("should support exponential backoff", async () => {
      let calls = 0;
      const mockBackendOps = {
        release: mock(async () => ({ ok: true as const })),
        extend: mock(async () => ({
          ok: true as const,
          expiresAtMs: Date.now() + 30000,
        })),
      };

      (mockBackend.acquire as ReturnType<typeof mock>).mockImplementation(
        async () => {
          calls++;
          if (calls < 3) {
            return { ok: false, reason: "locked" };
          }
          const result: AcquireResult<TestCapabilities> = {
            ok: true,
            lockId: "test-lock-id",
            expiresAtMs: Date.now() + 30000,
            fence: "000000000000001",
          };
          return decorateAcquireResult(mockBackendOps, result, "test-key");
        },
      );

      await lock(mockBackend, async () => "success", {
        key: "test-key",
        ttlMs: 30000,
        acquisition: {
          maxRetries: 10,
          retryDelayMs: 5,
          timeoutMs: 5000,
          backoff: "exponential",
          jitter: "none",
        },
      });

      expect(calls).toBe(3);
    });

    it("should apply full jitter strategy (delay = random * baseDelay)", async () => {
      // Full jitter formula: delay = Math.random() * baseDelay
      // Mock Math.random to return 0.25, so delay should be 0.25 * 100 = 25ms
      // Mock setTimeout to capture exact delay values without wall-clock timing
      const originalRandom = Math.random;
      const originalDateNow = Date.now;
      const originalSetTimeout = globalThis.setTimeout;

      Math.random = () => 0.25;
      let mockTime = 1000;
      const delaysPassed: number[] = [];

      Date.now = () => mockTime;

      // Mock setTimeout to capture delay values and resolve immediately
      globalThis.setTimeout = ((callback: () => void, ms: number) => {
        delaysPassed.push(ms);
        mockTime += ms; // Advance mock time
        callback(); // Resolve immediately
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;

      let calls = 0;
      const mockBackendOps = {
        release: mock(async () => ({ ok: true as const })),
        extend: mock(async () => ({
          ok: true as const,
          expiresAtMs: mockTime + 30000,
        })),
      };

      (mockBackend.acquire as ReturnType<typeof mock>).mockImplementation(
        async () => {
          calls++;
          if (calls < 3) {
            return { ok: false, reason: "locked" };
          }
          const result: AcquireResult<TestCapabilities> = {
            ok: true,
            lockId: "test-lock-id",
            expiresAtMs: mockTime + 30000,
            fence: "000000000000001",
          };
          return decorateAcquireResult(mockBackendOps, result, "test-key");
        },
      );

      try {
        const baseDelay = 100;
        await lock(mockBackend, async () => "success", {
          key: "test-key",
          ttlMs: 30000,
          acquisition: {
            maxRetries: 10,
            retryDelayMs: baseDelay,
            timeoutMs: 5000,
            backoff: "fixed",
            jitter: "full",
          },
        });

        expect(calls).toBe(3);

        // With random() = 0.25, full jitter: delay = 0.25 * 100 = 25ms exactly
        // 2 retries = 2 delays
        expect(delaysPassed.length).toBe(2);
        expect(delaysPassed[0]).toBe(25); // Exact value, not 100 (no jitter)
        expect(delaysPassed[1]).toBe(25);
      } finally {
        Math.random = originalRandom;
        Date.now = originalDateNow;
        globalThis.setTimeout = originalSetTimeout;
      }
    });

    it("should apply equal jitter strategy (delay = base/2 + random * base/2)", async () => {
      // Equal jitter formula: delay = baseDelay/2 + Math.random() * baseDelay/2
      // Mock Math.random to return 0.5, so delay = 50 + 0.5 * 50 = 75ms
      const originalRandom = Math.random;
      const originalDateNow = Date.now;
      const originalSetTimeout = globalThis.setTimeout;

      Math.random = () => 0.5;
      let mockTime = 1000;
      const delaysPassed: number[] = [];

      Date.now = () => mockTime;

      globalThis.setTimeout = ((callback: () => void, ms: number) => {
        delaysPassed.push(ms);
        mockTime += ms;
        callback();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;

      let calls = 0;
      const mockBackendOps = {
        release: mock(async () => ({ ok: true as const })),
        extend: mock(async () => ({
          ok: true as const,
          expiresAtMs: mockTime + 30000,
        })),
      };

      (mockBackend.acquire as ReturnType<typeof mock>).mockImplementation(
        async () => {
          calls++;
          if (calls < 3) {
            return { ok: false, reason: "locked" };
          }
          const result: AcquireResult<TestCapabilities> = {
            ok: true,
            lockId: "test-lock-id",
            expiresAtMs: mockTime + 30000,
            fence: "000000000000001",
          };
          return decorateAcquireResult(mockBackendOps, result, "test-key");
        },
      );

      try {
        const baseDelay = 100;
        await lock(mockBackend, async () => "success", {
          key: "test-key",
          ttlMs: 30000,
          acquisition: {
            maxRetries: 10,
            retryDelayMs: baseDelay,
            timeoutMs: 5000,
            backoff: "fixed",
            jitter: "equal",
          },
        });

        expect(calls).toBe(3);

        // With random() = 0.5, equal jitter: delay = 50 + 0.5 * 50 = 75ms exactly
        expect(delaysPassed.length).toBe(2);
        expect(delaysPassed[0]).toBe(75); // Exact value, not 100 or 50
        expect(delaysPassed[1]).toBe(75);
      } finally {
        Math.random = originalRandom;
        Date.now = originalDateNow;
        globalThis.setTimeout = originalSetTimeout;
      }
    });
  });

  describe("timeout edge cases", () => {
    it("should throw when retry delay is clamped to zero by remaining time", async () => {
      // This tests the retryDelay <= 0 branch (lines 206-210) which guards against
      // a race where remaining time becomes <= 0 between the pre-acquire timeout
      // check (line 150) and the retry delay calculation (line 195-203).
      //
      // We use Date.now() mocking to deterministically trigger this edge case:
      // - First call: time = 0 (start), passes timeout check
      // - acquire() contends
      // - After acquire returns: time = 101 (exceeds 100ms timeout)
      // - retryDelay calculation sees remainingTime = 100 - 101 = -1
      // - retryDelay is clamped to max(0, -1) = 0
      // - Branch throws "Timeout reached before next retry"
      const originalDateNow = Date.now;
      let mockTime = 1000;

      Date.now = () => mockTime;

      let calls = 0;
      (mockBackend.acquire as ReturnType<typeof mock>).mockImplementation(
        async () => {
          calls++;
          if (calls === 1) {
            // Simulate time passing during acquire - exceeds timeout
            mockTime += 101;
            return { ok: false, reason: "locked" };
          }
          return { ok: false, reason: "locked" };
        },
      );

      try {
        await lock(mockBackend, async () => "success", {
          key: "test-key",
          ttlMs: 30000,
          acquisition: {
            maxRetries: 100,
            retryDelayMs: 10,
            timeoutMs: 100, // 100ms timeout, but mock jumps to 101ms
            backoff: "fixed",
            jitter: "none",
          },
        });
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(LockError);
        expect((error as LockError).code).toBe("AcquisitionTimeout");
        // Verify we hit the specific retryDelay <= 0 branch
        expect((error as LockError).message).toMatch(
          /Timeout reached before next retry/,
        );
      } finally {
        Date.now = originalDateNow;
      }

      expect(calls).toBe(1);
    });
  });

  describe("AbortSignal support", () => {
    it("should abort on signal abort before acquire", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        lock(mockBackend, async () => "success", {
          key: "test-key",
          ttlMs: 30000,
          signal: controller.signal,
        }),
      ).rejects.toThrow(LockError);

      await expect(
        lock(mockBackend, async () => "success", {
          key: "test-key",
          ttlMs: 30000,
          signal: controller.signal,
        }),
      ).rejects.toThrow(/cancelled by user signal/);
    });

    it("should abort on acquisition signal abort", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        lock(mockBackend, async () => "success", {
          key: "test-key",
          ttlMs: 30000,
          acquisition: {
            signal: controller.signal,
          },
        }),
      ).rejects.toThrow(/Acquisition cancelled/);
    });

    it("should pass signal to backend acquire", async () => {
      const controller = new AbortController();

      await lock(mockBackend, async () => "success", {
        key: "test-key",
        ttlMs: 30000,
        signal: controller.signal,
      });

      expect(mockBackend.acquire).toHaveBeenCalledWith({
        key: "test-key",
        ttlMs: 30000,
        signal: controller.signal,
      });
    });
  });

  describe("error handling", () => {
    it("should propagate function errors", async () => {
      await expect(
        lock(
          mockBackend,
          async () => {
            throw new Error("Function error");
          },
          {
            key: "test-key",
            ttlMs: 30000,
          },
        ),
      ).rejects.toThrow("Function error");

      // Should still release the lock
      expect(mockBackend.release).toHaveBeenCalled();
    });

    it("should wrap unexpected acquire errors as Internal", async () => {
      (mockBackend.acquire as ReturnType<typeof mock>).mockRejectedValueOnce(
        new Error("Unexpected error"),
      );

      await expect(
        lock(mockBackend, async () => "success", {
          key: "test-key",
          ttlMs: 30000,
        }),
      ).rejects.toThrow(LockError);
    });

    it("should validate ttlMs is positive integer", async () => {
      await expect(
        lock(mockBackend, async () => "success", {
          key: "test-key",
          ttlMs: -1,
        }),
      ).rejects.toThrow(/ttlMs must be a positive integer/);

      await expect(
        lock(mockBackend, async () => "success", {
          key: "test-key",
          ttlMs: 0,
        }),
      ).rejects.toThrow(/ttlMs must be a positive integer/);

      await expect(
        lock(mockBackend, async () => "success", {
          key: "test-key",
          ttlMs: 1.5,
        }),
      ).rejects.toThrow(/ttlMs must be a positive integer/);
    });

    it("should validate key", async () => {
      await expect(
        lock(mockBackend, async () => "success", {
          key: "",
          ttlMs: 30000,
        }),
      ).rejects.toThrow(/Key must not be empty/);
    });
  });

  describe("default ttlMs", () => {
    it("should use default ttlMs when not provided", async () => {
      await lock(mockBackend, async () => "success", {
        key: "test-key",
      });

      // Should use BACKEND_DEFAULTS.ttlMs (30000)
      expect(mockBackend.acquire).toHaveBeenCalledWith({
        key: "test-key",
        ttlMs: 30000,
        signal: undefined,
      });
    });
  });

  describe("release failure handling", () => {
    it("should return function result when release fails", async () => {
      (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
        new Error("Release failed"),
      );

      const result = await lock(mockBackend, async () => "success", {
        key: "test-key",
        ttlMs: 30000,
      });

      expect(result).toBe("success");
    });

    it("should call default error handler when release fails (non-production)", async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      const consoleSpy = mock((..._args: unknown[]) => {});
      const originalError = console.error;
      console.error = consoleSpy;

      try {
        (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
          new Error("Network error"),
        );

        await lock(mockBackend, async () => "success", {
          key: "test-key",
          ttlMs: 30000,
        });

        expect(consoleSpy).toHaveBeenCalled();
        const callArgs = consoleSpy.mock.calls[0]!;
        expect(callArgs[0]).toBe("[SyncGuard] Lock disposal failed:");
        expect(callArgs[1]).toMatchObject({
          error: "Network error",
          errorName: "Error",
          source: "disposal",
        });
      } finally {
        process.env.NODE_ENV = originalEnv;
        console.error = originalError;
      }
    });

    it("should call custom onReleaseError when release fails", async () => {
      const onReleaseError = mock(
        (
          _err: Error,
          _ctx: { lockId: string; key: string; source: string },
        ) => {},
      );
      (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
        new Error("Release failed"),
      );

      await lock(mockBackend, async () => "success", {
        key: "test-key",
        ttlMs: 30000,
        onReleaseError,
      });

      expect(onReleaseError).toHaveBeenCalledTimes(1);
      const [err, ctx] = onReleaseError.mock.calls[0]!;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe("Release failed");
      expect(ctx).toMatchObject({
        lockId: "test-lock-id",
        key: "test-key",
        source: "disposal",
      });
    });

    it("should normalize non-Error release failures", async () => {
      const onReleaseError = mock((_err: Error, _ctx: unknown) => {});
      (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
        "string error",
      );

      await lock(mockBackend, async () => "success", {
        key: "test-key",
        ttlMs: 30000,
        onReleaseError,
      });

      expect(onReleaseError).toHaveBeenCalledTimes(1);
      const [err] = onReleaseError.mock.calls[0]!;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe("string error");
      expect((err as Error & { originalError?: unknown }).originalError).toBe(
        "string error",
      );
    });

    it("should swallow errors thrown by onReleaseError callback", async () => {
      const onReleaseError = mock(() => {
        throw new Error("Callback error");
      });
      (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
        new Error("Release failed"),
      );

      // Should not throw despite callback error
      const result = await lock(mockBackend, async () => "success", {
        key: "test-key",
        ttlMs: 30000,
        onReleaseError,
      });

      expect(result).toBe("success");
      expect(onReleaseError).toHaveBeenCalled();
    });

    it("should propagate function error even when release fails", async () => {
      const onReleaseError = mock(() => {});
      (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
        new Error("Release failed"),
      );

      await expect(
        lock(
          mockBackend,
          async () => {
            throw new Error("Function error");
          },
          {
            key: "test-key",
            ttlMs: 30000,
            onReleaseError,
          },
        ),
      ).rejects.toThrow("Function error");

      // onReleaseError should still be called
      expect(onReleaseError).toHaveBeenCalled();
    });
  });
});
