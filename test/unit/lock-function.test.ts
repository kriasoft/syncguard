// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Unit tests for the core lock function implementation
 *
 * Tests the createAutoLock internal utility function behavior including:
 * - Automatic lock management with withLock pattern
 * - Release error handling and callbacks
 * - Error propagation and cleanup behavior
 *
 * Note: createAutoLock is an internal utility used by backend modules.
 * Public API users should use lock() directly or backend-specific createLock().
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
import { decorateAcquireResult } from "../../common/disposable.js";
import type {
  AcquireResult,
  BackendCapabilities,
  ExtendResult,
  LockBackend,
  LockConfig,
  ReleaseResult,
} from "../../common/types.js";

// Save original environment variables
const originalNodeEnv = process.env.NODE_ENV;
const originalDebug = process.env.SYNCGUARD_DEBUG;

describe("Lock Function Tests", () => {
  let mockBackend: LockBackend<BackendCapabilities & { supportsFencing: true }>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Mock console methods to verify default handler behavior
    consoleWarnSpy?.mockRestore(); // Restore previous spy if exists
    consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy?.mockRestore();
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});

    // Create mock backend with successful acquire, but controllable release
    // Note: We need to use a variable to reference mockBackend for decorateAcquireResult
    const mockBackendOps = {
      release: mock(
        (): Promise<ReleaseResult> => Promise.resolve({ ok: true }),
      ),
      extend: mock(
        (): Promise<ExtendResult> =>
          Promise.resolve({ ok: true, expiresAtMs: Date.now() + 30000 }),
      ),
    };

    mockBackend = {
      acquire: mock(async () => {
        const result: AcquireResult<
          BackendCapabilities & { supportsFencing: true }
        > = {
          ok: true,
          lockId: "test-lock-id",
          expiresAtMs: Date.now() + 30000,
          fence: "000000000000001",
        };
        return decorateAcquireResult(
          mockBackendOps,
          result,
          "test-key",
          undefined,
        );
      }),
      release: mockBackendOps.release,
      extend: mockBackendOps.extend,
      isLocked: mock((): Promise<boolean> => Promise.resolve(false)),
      lookup: mock(() => Promise.resolve(null)),
      capabilities: {
        supportsFencing: true,
        timeAuthority: "server" as const,
      },
    };
  });

  afterEach(() => {
    consoleWarnSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();
    // Restore environment variables
    process.env.NODE_ENV = originalNodeEnv;
    if (originalDebug !== undefined) {
      process.env.SYNCGUARD_DEBUG = originalDebug;
    } else {
      delete process.env.SYNCGUARD_DEBUG;
    }
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
        source: "disposal", // Changed from "manual" - this is automatic cleanup
      });

      // Should not fall back to default handler when custom callback is provided
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("should use default handler in development when no callback provided", async () => {
      process.env.NODE_ENV = "development";

      const releaseError = new Error("Connection timeout");

      // Mock release to throw an error
      (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
        releaseError,
      );

      const lock = createAutoLock(mockBackend);

      const config: LockConfig = {
        key: "test-resource",
        // No release error callback provided - should use default handler
      };

      // Execute lock function - should succeed despite release failure
      const result = await lock(async () => "success", config);

      expect(result).toBe("success");
      // Default handler should log to console.error in development
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[SyncGuard] Lock disposal failed:",
        {
          error: "Connection timeout",
          errorName: "Error",
          source: "disposal",
        },
      );
    });

    it("should use default handler silently in production when no callback provided", async () => {
      process.env.NODE_ENV = "production";
      delete process.env.SYNCGUARD_DEBUG;

      const releaseError = new Error("Connection timeout");

      // Mock release to throw an error
      (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
        releaseError,
      );

      const lock = createAutoLock(mockBackend);

      const config: LockConfig = {
        key: "test-resource",
        // No release error callback provided - should use default handler
      };

      // Execute lock function - should succeed despite release failure
      const result = await lock(async () => "success", config);

      expect(result).toBe("success");
      // Default handler should be silent in production
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("should use default handler with SYNCGUARD_DEBUG=true in production", async () => {
      process.env.NODE_ENV = "production";
      process.env.SYNCGUARD_DEBUG = "true";

      const releaseError = new Error("Debug mode error");

      // Mock release to throw an error
      (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
        releaseError,
      );

      const lock = createAutoLock(mockBackend);

      const config: LockConfig = {
        key: "test-resource",
        // No release error callback provided - should use default handler
      };

      // Execute lock function - should succeed despite release failure
      const result = await lock(async () => "success", config);

      expect(result).toBe("success");
      // Default handler should log when SYNCGUARD_DEBUG=true
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[SyncGuard] Lock disposal failed:",
        {
          error: "Debug mode error",
          errorName: "Error",
          source: "disposal",
        },
      );
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
      expect(context).toEqual({
        lockId: "test-lock-id",
        key: "test-resource",
        source: "disposal",
      });

      // Should preserve original error for debugging
      expect((error as any).originalError).toBe("Network failure");
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
        source: "disposal",
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
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });
});
