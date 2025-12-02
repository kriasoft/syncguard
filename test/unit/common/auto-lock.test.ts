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
});
