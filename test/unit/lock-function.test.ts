// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Unit tests for the core lock function implementation
 *
 * Tests the createAutoLock function behavior including:
 * - Automatic lock management with withLock pattern
 * - Release error handling and callbacks
 * - Error propagation and cleanup behavior
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { createAutoLock } from "../../common/backend";
import type {
  AcquireResult,
  BackendCapabilities,
  ExtendResult,
  LockBackend,
  LockConfig,
  ReleaseResult,
} from "../../common/types.js";

describe("Lock Function Tests", () => {
  let mockBackend: LockBackend<BackendCapabilities & { supportsFencing: true }>;
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Mock console.warn to verify fallback behavior
    consoleSpy?.mockRestore(); // Restore previous spy if exists
    consoleSpy = spyOn(console, "warn").mockImplementation(() => {});

    // Create mock backend with successful acquire, but controllable release
    mockBackend = {
      acquire: mock(
        (): Promise<
          AcquireResult<BackendCapabilities & { supportsFencing: true }>
        > =>
          Promise.resolve({
            ok: true,
            lockId: "test-lock-id",
            expiresAtMs: Date.now() + 30000,
            fence: "0000000000000000001",
          }),
      ),
      release: mock(
        (): Promise<ReleaseResult> => Promise.resolve({ ok: true }),
      ),
      extend: mock(
        (): Promise<ExtendResult> =>
          Promise.resolve({ ok: true, expiresAtMs: Date.now() + 30000 }),
      ),
      isLocked: mock((): Promise<boolean> => Promise.resolve(false)),
      lookup: mock(() => Promise.resolve(null)),
      capabilities: {
        supportsFencing: true,
        timeAuthority: "server" as const,
      },
    };
  });

  afterEach(() => {
    consoleSpy?.mockRestore();
  });

  describe("Release Error Handling", () => {
    it("should call onReleaseError callback when release fails", async () => {
      const releaseError = new Error("Redis connection failed");
      const onReleaseErrorSpy = mock();

      // Mock release to throw an error
      (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
        releaseError,
      );

      const lock = createAutoLock(mockBackend);

      const config: LockConfig = {
        key: "test-resource",
        onReleaseError: onReleaseErrorSpy,
      };

      // Execute lock function - should succeed despite release failure
      const result = await lock(async () => "success", config);

      expect(result).toBe("success");
      expect(onReleaseErrorSpy).toHaveBeenCalledTimes(1);
      expect(onReleaseErrorSpy).toHaveBeenCalledWith(releaseError, {
        lockId: "test-lock-id",
        key: "test-resource",
      });

      // Should not fall back to console.warn when callback is provided
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it("should silently ignore release errors when no callback provided", async () => {
      const releaseError = new Error("Connection timeout");

      // Mock release to throw an error
      (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
        releaseError,
      );

      const lock = createAutoLock(mockBackend);

      const config: LockConfig = {
        key: "test-resource",
        // No release error callback provided
      };

      // Execute lock function - should succeed despite release failure
      const result = await lock(async () => "success", config);

      expect(result).toBe("success");
      // No console.warn should be called - errors are silently ignored
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it("should handle non-Error objects thrown during release", async () => {
      const onReleaseErrorSpy = mock();

      // Mock release to throw a string instead of Error object
      (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
        "Network failure",
      );

      const lock = createAutoLock(mockBackend);

      const config: LockConfig = {
        key: "test-resource",
        onReleaseError: onReleaseErrorSpy,
      };

      // Execute lock function
      const result = await lock(async () => "success", config);

      expect(result).toBe("success");
      expect(onReleaseErrorSpy).toHaveBeenCalledTimes(1);

      // Should convert string to Error object
      const callArgs = onReleaseErrorSpy.mock.calls[0];
      expect(callArgs).toBeDefined();
      const [error, context] = callArgs!;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("Network failure");
      expect(context).toEqual({ lockId: "test-lock-id", key: "test-resource" });
    });

    it("should not mask function execution errors when release fails", async () => {
      const functionError = new Error("Function execution failed");
      const releaseError = new Error("Release failed");
      const onReleaseErrorSpy = mock();

      // Mock release to throw an error
      (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
        releaseError,
      );

      const lock = createAutoLock(mockBackend);

      const config: LockConfig = {
        key: "test-resource",
        onReleaseError: onReleaseErrorSpy,
      };

      // Function throws error during execution
      await expect(
        lock(async () => {
          throw functionError;
        }, config),
      ).rejects.toThrow("Function execution failed");

      // Release error callback should still be called
      expect(onReleaseErrorSpy).toHaveBeenCalledTimes(1);
      expect(onReleaseErrorSpy).toHaveBeenCalledWith(releaseError, {
        lockId: "test-lock-id",
        key: "test-resource",
      });
    });

    it("should work correctly when release succeeds", async () => {
      const onReleaseErrorSpy = mock();

      const lock = createAutoLock(mockBackend);

      const config: LockConfig = {
        key: "test-resource",
        onReleaseError: onReleaseErrorSpy,
      };

      // Normal execution - release should succeed
      const result = await lock(async () => "success", config);

      expect(result).toBe("success");
      expect(mockBackend.release).toHaveBeenCalledWith({
        lockId: "test-lock-id",
        signal: undefined,
      });

      // Callback should not be called when release succeeds
      expect(onReleaseErrorSpy).not.toHaveBeenCalled();
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });
});
