// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Unit tests for error callback handling during disposal
 *
 * Tests the error handling and callback invocation including:
 * - Manual release() throws errors
 * - Disposal invokes onReleaseError callback
 * - Error normalization to Error type
 * - Silent callback error swallowing
 * - Default callback behavior in development/production
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
import { createDisposableHandle } from "../../../common/disposable.js";
import type {
  AcquireOk,
  BackendCapabilities,
  ExtendResult,
  LockBackend,
  OnReleaseError,
  ReleaseResult,
} from "../../../common/types.js";

describe("Error Handling", () => {
  let mockBackend: Pick<
    LockBackend<BackendCapabilities & { supportsFencing: true }>,
    "release" | "extend"
  >;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  const mockAcquireResult: AcquireOk<
    BackendCapabilities & { supportsFencing: true }
  > = {
    ok: true,
    lockId: "test-lock-456",
    expiresAtMs: Date.now() + 30000,
    fence: "000000000000002",
  };

  beforeEach(() => {
    consoleErrorSpy?.mockRestore();
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});

    mockBackend = {
      release: mock(
        (): Promise<ReleaseResult> => Promise.resolve({ ok: true }),
      ),
      extend: mock(
        (): Promise<ExtendResult> =>
          Promise.resolve({ ok: true, expiresAtMs: Date.now() + 30000 }),
      ),
    };
  });

  afterEach(() => {
    consoleErrorSpy?.mockRestore();
  });

  it("should throw on manual release() for consistency with backend API", async () => {
    const releaseError = new Error("Network timeout");

    (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
      releaseError,
    );

    const handle = createDisposableHandle(
      mockBackend,
      mockAcquireResult,
      "test-key",
    );

    // Manual release() should throw exactly like backend.release()
    await expect(handle.release()).rejects.toThrow("Network timeout");
  });

  it("should throw on manual release() error (no callback invoked)", async () => {
    const releaseError = new Error("Redis connection lost");
    const onReleaseErrorSpy = mock<OnReleaseError>();

    (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
      releaseError,
    );

    const handle = createDisposableHandle(
      mockBackend,
      mockAcquireResult,
      "test-key",
      onReleaseErrorSpy,
    );

    // Manual release() should throw (not swallow)
    await expect(handle.release()).rejects.toThrow("Redis connection lost");

    // Callback NOT invoked for manual release (only for disposal)
    expect(onReleaseErrorSpy).not.toHaveBeenCalled();
  });

  it("should invoke onReleaseError during disposal with normalized Error", async () => {
    const releaseError = new Error("Network failure during disposal");
    const onReleaseErrorSpy = mock<OnReleaseError>();

    (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
      releaseError,
    );

    const handle = createDisposableHandle(
      mockBackend,
      mockAcquireResult,
      "test-key",
      onReleaseErrorSpy,
    );

    // Disposal should invoke callback (not throw)
    await handle[Symbol.asyncDispose]();

    expect(onReleaseErrorSpy).toHaveBeenCalledTimes(1);
    expect(onReleaseErrorSpy).toHaveBeenCalledWith(releaseError, {
      lockId: "test-lock-456",
      key: "test-key",
      source: "disposal",
    });
  });

  it("should normalize non-Error objects during disposal", async () => {
    const onReleaseErrorSpy = mock<OnReleaseError>();

    // Throw a string instead of Error
    (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
      "Connection timeout",
    );

    const handle = createDisposableHandle(
      mockBackend,
      mockAcquireResult,
      "test-key",
      onReleaseErrorSpy,
    );

    // Disposal normalizes non-Error to Error
    await handle[Symbol.asyncDispose]();

    expect(onReleaseErrorSpy).toHaveBeenCalledTimes(1);

    const [error, context] = onReleaseErrorSpy.mock.calls[0]!;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Connection timeout");
    expect(context).toEqual({
      lockId: "test-lock-456",
      key: "test-key",
      source: "disposal",
    });
  });

  it("should silently swallow callback errors during disposal without logging", async () => {
    const releaseError = new Error("Backend error");
    const callbackError = new Error("Callback failed");
    const onReleaseErrorSpy = mock<OnReleaseError>(() => {
      throw callbackError;
    });

    (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
      releaseError,
    );

    const handle = createDisposableHandle(
      mockBackend,
      mockAcquireResult,
      "test-key",
      onReleaseErrorSpy,
    );

    // Disposal should not throw despite callback error
    await handle[Symbol.asyncDispose]();

    expect(onReleaseErrorSpy).toHaveBeenCalledTimes(1);
    // Callback errors are silently swallowed - no console.error
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("should not invoke callback when release succeeds", async () => {
    const onReleaseErrorSpy = mock<OnReleaseError>();

    const handle = createDisposableHandle(
      mockBackend,
      mockAcquireResult,
      "test-key",
      onReleaseErrorSpy,
    );

    const result = await handle.release();

    expect(result).toEqual({ ok: true });
    expect(onReleaseErrorSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("should throw on manual release() without callback", async () => {
    const releaseError = new Error("Network failure");

    (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
      releaseError,
    );

    const handle = createDisposableHandle(
      mockBackend,
      mockAcquireResult,
      "test-key",
      // No callback provided
    );

    // Manual release() should throw even without callback
    await expect(handle.release()).rejects.toThrow("Network failure");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("should use default callback that logs in development", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    const releaseError = new Error("Network failure in dev");

    (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
      releaseError,
    );

    const handle = createDisposableHandle(
      mockBackend,
      mockAcquireResult,
      "test-key",
      // No callback provided - uses default
    );

    try {
      // Disposal should not throw (best-effort cleanup)
      await handle[Symbol.asyncDispose]();

      // Default callback should log in development
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[SyncGuard] Lock disposal failed:",
        {
          error: "Network failure in dev",
          errorName: "Error",
          source: "disposal",
          // Note: key and lockId are omitted for security
        },
      );
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("should use default callback that is silent in production", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalDebug = process.env.SYNCGUARD_DEBUG;
    process.env.NODE_ENV = "production";
    delete process.env.SYNCGUARD_DEBUG;

    const releaseError = new Error("Network failure in prod");

    (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
      releaseError,
    );

    const handle = createDisposableHandle(
      mockBackend,
      mockAcquireResult,
      "test-key",
      // No callback provided - uses default
    );

    try {
      // Disposal should not throw
      await handle[Symbol.asyncDispose]();

      // Default callback should NOT log in production
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalDebug !== undefined) {
        process.env.SYNCGUARD_DEBUG = originalDebug;
      }
    }
  });

  it("should use default callback that logs in production when SYNCGUARD_DEBUG=true", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalDebug = process.env.SYNCGUARD_DEBUG;
    process.env.NODE_ENV = "production";
    process.env.SYNCGUARD_DEBUG = "true";

    const releaseError = new Error("Network failure in prod with debug");

    (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
      releaseError,
    );

    const handle = createDisposableHandle(
      mockBackend,
      mockAcquireResult,
      "test-key",
      // No callback provided - uses default
    );

    try {
      // Disposal should not throw
      await handle[Symbol.asyncDispose]();

      // Default callback SHOULD log when SYNCGUARD_DEBUG=true
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[SyncGuard] Lock disposal failed:",
        {
          error: "Network failure in prod with debug",
          errorName: "Error",
          source: "disposal",
        },
      );
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalDebug !== undefined) {
        process.env.SYNCGUARD_DEBUG = originalDebug;
      } else {
        delete process.env.SYNCGUARD_DEBUG;
      }
    }
  });

  it("should allow custom callback to override default", async () => {
    const customCallback = mock<OnReleaseError>();
    const releaseError = new Error("Custom callback test");

    (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
      releaseError,
    );

    const handle = createDisposableHandle(
      mockBackend,
      mockAcquireResult,
      "test-key",
      customCallback, // Custom callback provided
    );

    await handle[Symbol.asyncDispose]();

    // Custom callback should be invoked
    expect(customCallback).toHaveBeenCalledTimes(1);
    expect(customCallback).toHaveBeenCalledWith(releaseError, {
      lockId: "test-lock-456",
      key: "test-key",
      source: "disposal",
    });

    // Default callback should NOT be used
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("should not log when disposal succeeds (default callback)", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    // Release succeeds - no error
    (mockBackend.release as ReturnType<typeof mock>).mockResolvedValue({
      ok: true,
    });

    const handle = createDisposableHandle(
      mockBackend,
      mockAcquireResult,
      "test-key",
      // No callback - uses default
    );

    try {
      await handle[Symbol.asyncDispose]();

      // No error, so default callback should not log
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
