// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Unit tests for AsyncDisposable support (common/disposable.ts)
 *
 * Tests the disposal pattern including:
 * - Idempotent disposal (safe to call multiple times)
 * - No-op disposal for failed acquisitions
 * - Error handling and callback invocation
 * - Error normalization to Error type
 * - Source field differentiation (disposal vs manual)
 * - Silent swallowing of callback errors (no logging)
 * - Integration with acquire result decoration
 * - Type narrowing via TypeScript discriminated unions
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
import {
  createDisposableHandle,
  decorateAcquireResult,
} from "../../common/disposable.js";
import type {
  AcquireOk,
  AcquireResult,
  BackendCapabilities,
  ExtendResult,
  LockBackend,
  OnReleaseError,
  ReleaseResult,
} from "../../common/types.js";

describe("Disposable Lock Tests", () => {
  let mockBackend: Pick<
    LockBackend<BackendCapabilities & { supportsFencing: true }>,
    "release" | "extend"
  >;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Spy on console.error to verify callback error logging
    consoleErrorSpy?.mockRestore();
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});

    // Create minimal mock backend for disposal tests
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

  describe("createDisposableHandle", () => {
    const mockAcquireResult: AcquireOk<
      BackendCapabilities & { supportsFencing: true }
    > = {
      ok: true,
      lockId: "test-lock-123",
      expiresAtMs: Date.now() + 30000,
      fence: "000000000000001",
    };

    it("should create handle with disposal methods", async () => {
      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      expect(handle).toBeDefined();
      expect(handle.ok).toBe(true);
      expect(handle.lockId).toBe("test-lock-123");
      expect(handle.fence).toBe("000000000000001");
      expect(typeof handle.release).toBe("function");
      expect(typeof handle.extend).toBe("function");
      expect(typeof handle[Symbol.asyncDispose]).toBe("function");
    });

    it("should call backend.release on manual release()", async () => {
      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      const result = await handle.release();

      expect(result).toEqual({ ok: true });
      expect(mockBackend.release).toHaveBeenCalledWith({
        lockId: "test-lock-123",
      });
      expect(mockBackend.release).toHaveBeenCalledTimes(1);
    });

    it("should be idempotent - multiple calls only hit backend once", async () => {
      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      // First release succeeds
      const result1 = await handle.release();
      expect(result1).toEqual({ ok: true });

      // Subsequent releases are short-circuited (returns ok: false immediately)
      const result2 = await handle.release();
      expect(result2).toEqual({ ok: false });

      const result3 = await handle.release();
      expect(result3).toEqual({ ok: false });

      // Backend called only once (local state tracking for idempotency)
      expect(mockBackend.release).toHaveBeenCalledTimes(1);
    });

    it("should call backend.extend", async () => {
      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      const result = await handle.extend(15000);

      expect(result.ok).toBe(true);
      expect(mockBackend.extend).toHaveBeenCalledWith({
        lockId: "test-lock-123",
        ttlMs: 15000,
        signal: undefined,
      });
    });

    it("should allow extend() after release (extend is not affected by disposal)", async () => {
      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      await handle.release();

      // Mock backend to return ok: false for extend (lock absent)
      (mockBackend.extend as ReturnType<typeof mock>).mockResolvedValue({
        ok: false,
      });

      const result = await handle.extend(15000);

      // Backend is called (extend is not affected by disposed flag)
      expect(result).toEqual({ ok: false });
      expect(mockBackend.extend).toHaveBeenCalledWith({
        lockId: "test-lock-123",
        ttlMs: 15000,
        signal: undefined,
      });
    });

    it("should call release() on disposal", async () => {
      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      await handle[Symbol.asyncDispose]();

      expect(mockBackend.release).toHaveBeenCalledWith({
        lockId: "test-lock-123",
      });
    });

    it("should never throw from disposal", async () => {
      const releaseError = new Error("Network failure");
      (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
        releaseError,
      );

      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      // Disposal should not throw
      await expect(handle[Symbol.asyncDispose]()).resolves.toBeUndefined();
    });

    it("should be idempotent - multiple disposal calls only hit backend once", async () => {
      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      // First disposal succeeds
      await handle[Symbol.asyncDispose]();
      expect(mockBackend.release).toHaveBeenCalledTimes(1);

      // Second disposal is no-op (doesn't hit backend)
      await handle[Symbol.asyncDispose]();
      expect(mockBackend.release).toHaveBeenCalledTimes(1);

      // Third disposal is also no-op
      await handle[Symbol.asyncDispose]();
      expect(mockBackend.release).toHaveBeenCalledTimes(1);
    });

    it("should be idempotent - manual release + disposal only hits backend once", async () => {
      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      // Manual release
      const result = await handle.release();
      expect(result).toEqual({ ok: true });
      expect(mockBackend.release).toHaveBeenCalledTimes(1);

      // Automatic disposal is no-op (already released)
      await handle[Symbol.asyncDispose]();
      expect(mockBackend.release).toHaveBeenCalledTimes(1);
    });
  });

  describe("Error Handling", () => {
    const mockAcquireResult: AcquireOk<
      BackendCapabilities & { supportsFencing: true }
    > = {
      ok: true,
      lockId: "test-lock-456",
      expiresAtMs: Date.now() + 30000,
      fence: "000000000000002",
    };

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

  describe("decorateAcquireResult", () => {
    it("should attach disposal methods to successful acquisition", async () => {
      const successResult: AcquireResult<
        BackendCapabilities & { supportsFencing: true }
      > = {
        ok: true,
        lockId: "test-lock-789",
        expiresAtMs: Date.now() + 30000,
        fence: "000000000000003",
      };

      const decorated = decorateAcquireResult(
        mockBackend,
        successResult,
        "test-key",
      );

      expect(decorated.ok).toBe(true);
      if (decorated.ok) {
        // Type narrowing allows access to disposal methods
        expect(typeof decorated.release).toBe("function");
        expect(typeof decorated.extend).toBe("function");
        expect(typeof decorated[Symbol.asyncDispose]).toBe("function");
      }
    });

    it("should attach no-op handle methods to failed acquisition", async () => {
      const failResult: AcquireResult<
        BackendCapabilities & { supportsFencing: true }
      > = {
        ok: false,
        reason: "locked",
      };

      const decorated = decorateAcquireResult(
        mockBackend,
        failResult,
        "test-key",
      );

      expect(decorated.ok).toBe(false);
      expect(typeof decorated[Symbol.asyncDispose]).toBe("function");
      expect(typeof decorated.release).toBe("function");
      expect(typeof decorated.extend).toBe("function");

      // Disposal should be no-op - no backend calls
      await decorated[Symbol.asyncDispose]();

      expect(mockBackend.release).not.toHaveBeenCalled();
    });

    it("should return { ok: false } when calling release() on failed acquisition", async () => {
      const failResult: AcquireResult<
        BackendCapabilities & { supportsFencing: true }
      > = {
        ok: false,
        reason: "locked",
      };

      const decorated = decorateAcquireResult(
        mockBackend,
        failResult,
        "test-key",
      );

      // Call release() - should return { ok: false } immediately
      const result = await decorated.release();

      expect(result).toEqual({ ok: false });
      // No backend call should be made
      expect(mockBackend.release).not.toHaveBeenCalled();
    });

    it("should return { ok: false } when calling extend() on failed acquisition", async () => {
      const failResult: AcquireResult<
        BackendCapabilities & { supportsFencing: true }
      > = {
        ok: false,
        reason: "locked",
      };

      const decorated = decorateAcquireResult(
        mockBackend,
        failResult,
        "test-key",
      );

      // Call extend() - should return { ok: false } immediately
      const result = await decorated.extend(5000);

      expect(result).toEqual({ ok: false });
      // No backend call should be made
      expect(mockBackend.extend).not.toHaveBeenCalled();
    });

    it("should support multiple calls to release() on failed acquisition", async () => {
      const failResult: AcquireResult<
        BackendCapabilities & { supportsFencing: true }
      > = {
        ok: false,
        reason: "locked",
      };

      const decorated = decorateAcquireResult(
        mockBackend,
        failResult,
        "test-key",
      );

      // Multiple calls to release() - all should return { ok: false }
      const result1 = await decorated.release();
      const result2 = await decorated.release();
      const result3 = await decorated.release();

      expect(result1).toEqual({ ok: false });
      expect(result2).toEqual({ ok: false });
      expect(result3).toEqual({ ok: false });
      // No backend calls should be made
      expect(mockBackend.release).not.toHaveBeenCalled();
    });

    it("should support calling both release() and extend() on failed acquisition", async () => {
      const failResult: AcquireResult<
        BackendCapabilities & { supportsFencing: true }
      > = {
        ok: false,
        reason: "locked",
      };

      const decorated = decorateAcquireResult(
        mockBackend,
        failResult,
        "test-key",
      );

      // Mix calls to release() and extend()
      const releaseResult1 = await decorated.release();
      const extendResult1 = await decorated.extend(5000);
      const releaseResult2 = await decorated.release();
      const extendResult2 = await decorated.extend(10000);

      expect(releaseResult1).toEqual({ ok: false });
      expect(extendResult1).toEqual({ ok: false });
      expect(releaseResult2).toEqual({ ok: false });
      expect(extendResult2).toEqual({ ok: false });

      // No backend calls should be made
      expect(mockBackend.release).not.toHaveBeenCalled();
      expect(mockBackend.extend).not.toHaveBeenCalled();
    });

    it("should pass onReleaseError to disposal (not manual release)", async () => {
      const onReleaseErrorSpy = mock<OnReleaseError>();
      const releaseError = new Error("Disposal failed");

      (mockBackend.release as ReturnType<typeof mock>).mockRejectedValueOnce(
        releaseError,
      );

      const successResult: AcquireResult<
        BackendCapabilities & { supportsFencing: true }
      > = {
        ok: true,
        lockId: "test-lock-999",
        expiresAtMs: Date.now() + 30000,
        fence: "000000000000004",
      };

      const decorated = decorateAcquireResult(
        mockBackend,
        successResult,
        "test-key",
        onReleaseErrorSpy,
      );

      if (decorated.ok) {
        // Disposal triggers callback
        await decorated[Symbol.asyncDispose]();

        expect(onReleaseErrorSpy).toHaveBeenCalledWith(releaseError, {
          lockId: "test-lock-999",
          key: "test-key",
          source: "disposal",
        });
      }
    });
  });

  describe("Type Narrowing", () => {
    it("should allow access to methods after ok check (successful acquisition)", () => {
      const successResult: AcquireResult<
        BackendCapabilities & { supportsFencing: true }
      > = {
        ok: true,
        lockId: "test-lock-aaa",
        expiresAtMs: Date.now() + 30000,
        fence: "000000000000005",
      };

      const decorated = decorateAcquireResult(
        mockBackend,
        successResult,
        "test-key",
      );

      // After checking ok, TypeScript narrows to AsyncLock
      if (decorated.ok) {
        expect(decorated.lockId).toBe("test-lock-aaa");
        expect(typeof decorated.release).toBe("function");
        expect(typeof decorated.extend).toBe("function");
      }
    });

    it("should have methods on failed acquisition (no runtime errors)", () => {
      const failResult: AcquireResult<
        BackendCapabilities & { supportsFencing: true }
      > = {
        ok: false,
        reason: "locked",
      };

      const decorated = decorateAcquireResult(
        mockBackend,
        failResult,
        "test-key",
      );

      expect(decorated.ok).toBe(false);
      if (!decorated.ok) {
        expect(decorated.reason).toBe("locked");
        // Methods exist even for failed acquisition
        expect(typeof decorated.release).toBe("function");
        expect(typeof decorated.extend).toBe("function");
      }
    });

    it("should safely call methods without checking ok (JavaScript safety)", async () => {
      const failResult: AcquireResult<
        BackendCapabilities & { supportsFencing: true }
      > = {
        ok: false,
        reason: "locked",
      };

      const decorated = decorateAcquireResult(
        mockBackend,
        failResult,
        "test-key",
      );

      // In JavaScript (or with type assertions), someone might forget to check ok
      // This should NOT throw a runtime error - methods should exist and return { ok: false }
      const releaseResult = await decorated.release();
      const extendResult = await decorated.extend(5000);

      expect(releaseResult).toEqual({ ok: false });
      expect(extendResult).toEqual({ ok: false });

      // No backend calls made
      expect(mockBackend.release).not.toHaveBeenCalled();
      expect(mockBackend.extend).not.toHaveBeenCalled();
    });
  });

  describe("AbortSignal Support", () => {
    it("should forward signal to backend.release()", async () => {
      const mockAcquireResult: AcquireOk<
        BackendCapabilities & { supportsFencing: true }
      > = {
        ok: true,
        lockId: "test-lock-signal",
        expiresAtMs: Date.now() + 30000,
        fence: "000000000000001",
      };

      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      const abortController = new AbortController();
      await handle.release(abortController.signal);

      expect(mockBackend.release).toHaveBeenCalledWith({
        lockId: "test-lock-signal",
        signal: abortController.signal,
      });
    });

    it("should forward signal to backend.extend()", async () => {
      const mockAcquireResult: AcquireOk<
        BackendCapabilities & { supportsFencing: true }
      > = {
        ok: true,
        lockId: "test-lock-extend-signal",
        expiresAtMs: Date.now() + 30000,
        fence: "000000000000002",
      };

      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      const abortController = new AbortController();
      await handle.extend(15000, abortController.signal);

      expect(mockBackend.extend).toHaveBeenCalledWith({
        lockId: "test-lock-extend-signal",
        ttlMs: 15000,
        signal: abortController.signal,
      });
    });

    it("should work without signal parameter (backward compatibility)", async () => {
      const mockAcquireResult: AcquireOk<
        BackendCapabilities & { supportsFencing: true }
      > = {
        ok: true,
        lockId: "test-lock-no-signal",
        expiresAtMs: Date.now() + 30000,
        fence: "000000000000003",
      };

      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      // Call without signal parameter
      await handle.release();

      expect(mockBackend.release).toHaveBeenCalledWith({
        lockId: "test-lock-no-signal",
        signal: undefined,
      });
    });

    it("should allow different signals for release and extend", async () => {
      const mockAcquireResult: AcquireOk<
        BackendCapabilities & { supportsFencing: true }
      > = {
        ok: true,
        lockId: "test-lock-multi-signal",
        expiresAtMs: Date.now() + 30000,
        fence: "000000000000004",
      };

      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      const extendController = new AbortController();
      await handle.extend(10000, extendController.signal);

      expect(mockBackend.extend).toHaveBeenCalledWith({
        lockId: "test-lock-multi-signal",
        ttlMs: 10000,
        signal: extendController.signal,
      });

      // Now release with a different signal
      const releaseController = new AbortController();
      await handle.release(releaseController.signal);

      expect(mockBackend.release).toHaveBeenCalledWith({
        lockId: "test-lock-multi-signal",
        signal: releaseController.signal,
      });
    });
  });

  describe("Disposal Timeout", () => {
    const mockAcquireResult: AcquireOk<
      BackendCapabilities & { supportsFencing: true }
    > = {
      ok: true,
      lockId: "test-lock-timeout",
      expiresAtMs: Date.now() + 30000,
      fence: "000000000000099",
    };

    it("should abort disposal after timeout", async () => {
      const onReleaseErrorSpy = mock<OnReleaseError>();

      // Mock release to hang indefinitely
      (mockBackend.release as ReturnType<typeof mock>).mockImplementation(
        ({ signal }: { signal?: AbortSignal }) => {
          return new Promise((_, reject) => {
            if (signal) {
              signal.addEventListener("abort", () => {
                reject(new Error("AbortError: Release operation timed out"));
              });
            }
          });
        },
      );

      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
        onReleaseErrorSpy,
        100, // 100ms timeout
      );

      // Disposal should complete within timeout window
      const startTime = Date.now();
      await handle[Symbol.asyncDispose]();
      const elapsed = Date.now() - startTime;

      // Should abort around 100ms (allow some margin)
      expect(elapsed).toBeLessThan(200);
      expect(elapsed).toBeGreaterThanOrEqual(100);

      // Error callback should be invoked with abort error
      expect(onReleaseErrorSpy).toHaveBeenCalledTimes(1);
      const [error, context] = onReleaseErrorSpy.mock.calls[0]!;
      expect(error.message).toContain("timed out");
      expect(context).toEqual({
        lockId: "test-lock-timeout",
        key: "test-key",
        source: "disposal",
      });
    });

    it("should not timeout when release completes quickly", async () => {
      const onReleaseErrorSpy = mock<OnReleaseError>();

      // Reset mock to succeed quickly
      (mockBackend.release as ReturnType<typeof mock>).mockResolvedValue({
        ok: true,
      });

      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
        onReleaseErrorSpy,
        1000, // 1s timeout
      );

      const startTime = Date.now();
      await handle[Symbol.asyncDispose]();
      const elapsed = Date.now() - startTime;

      // Should complete quickly
      expect(elapsed).toBeLessThan(100);

      // No error callback invoked
      expect(onReleaseErrorSpy).not.toHaveBeenCalled();
    });

    it("should not apply timeout when disposeTimeoutMs is undefined", async () => {
      // Mock release to complete after 200ms
      (mockBackend.release as ReturnType<typeof mock>).mockImplementation(
        () => {
          return new Promise((resolve) => {
            setTimeout(() => resolve({ ok: true }), 200);
          });
        },
      );

      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
        undefined, // no callback
        undefined, // no timeout
      );

      const startTime = Date.now();
      await handle[Symbol.asyncDispose]();
      const elapsed = Date.now() - startTime;

      // Should wait full 200ms
      expect(elapsed).toBeGreaterThanOrEqual(200);
    });

    it("should pass signal to manual release when timeout is configured", async () => {
      const abortController = new AbortController();

      (mockBackend.release as ReturnType<typeof mock>).mockResolvedValue({
        ok: true,
      });

      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
        undefined,
        1000, // timeout configured but not used for manual release
      );

      await handle.release(abortController.signal);

      // Manual release uses provided signal, not timeout signal
      expect(mockBackend.release).toHaveBeenCalledWith({
        lockId: "test-lock-timeout",
        signal: abortController.signal,
      });
    });

    it("should work with decorateAcquireResult", async () => {
      const onReleaseErrorSpy = mock<OnReleaseError>();

      // Mock release to hang
      (mockBackend.release as ReturnType<typeof mock>).mockImplementation(
        ({ signal }: { signal?: AbortSignal }) => {
          return new Promise((_, reject) => {
            if (signal) {
              signal.addEventListener("abort", () => {
                reject(new Error("AbortError: Timed out"));
              });
            }
          });
        },
      );

      const successResult: AcquireResult<
        BackendCapabilities & { supportsFencing: true }
      > = {
        ok: true,
        lockId: "test-lock-decorated",
        expiresAtMs: Date.now() + 30000,
        fence: "000000000000100",
      };

      const decorated = decorateAcquireResult(
        mockBackend,
        successResult,
        "test-key",
        onReleaseErrorSpy,
        100, // 100ms timeout
      );

      if (decorated.ok) {
        const startTime = Date.now();
        await decorated[Symbol.asyncDispose]();
        const elapsed = Date.now() - startTime;

        expect(elapsed).toBeLessThan(200);
        expect(onReleaseErrorSpy).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe("Concurrent Disposal and Re-entry", () => {
    const mockAcquireResult: AcquireOk<
      BackendCapabilities & { supportsFencing: true }
    > = {
      ok: true,
      lockId: "test-lock-concurrent",
      expiresAtMs: Date.now() + 30000,
      fence: "000000000000777",
    };

    it("should handle concurrent disposal calls (only one backend call)", async () => {
      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      // Launch multiple concurrent disposal calls
      const disposalPromises = [
        handle[Symbol.asyncDispose](),
        handle[Symbol.asyncDispose](),
        handle[Symbol.asyncDispose](),
      ];

      // All should complete successfully
      await Promise.all(disposalPromises);

      // Backend should be called exactly once
      expect(mockBackend.release).toHaveBeenCalledTimes(1);
      expect(mockBackend.release).toHaveBeenCalledWith({
        lockId: "test-lock-concurrent",
      });
    });

    it("should return same promise for re-entry during disposal", async () => {
      // Mock release to be slow (100ms)
      (mockBackend.release as ReturnType<typeof mock>).mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ ok: true }), 100),
          ),
      );

      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      // Start first disposal
      const firstDisposal = handle[Symbol.asyncDispose]();

      // While first disposal is in-flight, start second disposal
      await Bun.sleep(10); // Give first disposal time to start
      const secondDisposal = handle[Symbol.asyncDispose]();

      // Both promises should resolve successfully
      await Promise.all([firstDisposal, secondDisposal]);

      // Backend should be called exactly once
      expect(mockBackend.release).toHaveBeenCalledTimes(1);
    });

    it("should handle mix of concurrent disposal and manual release", async () => {
      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      // Launch manual release and disposal concurrently
      const releasePromise = handle.release();
      const disposalPromise = handle[Symbol.asyncDispose]();

      const [releaseResult] = await Promise.all([
        releasePromise,
        disposalPromise,
      ]);

      // One should succeed, one should return { ok: false }
      // But backend should only be called once
      expect(mockBackend.release).toHaveBeenCalledTimes(1);

      // At least the first call should succeed
      expect(releaseResult.ok).toBe(true);
    });

    it("should handle disposal after manual release completes", async () => {
      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      // Manual release first
      const releaseResult = await handle.release();
      expect(releaseResult.ok).toBe(true);
      expect(mockBackend.release).toHaveBeenCalledTimes(1);

      // Then disposal (should be no-op)
      await handle[Symbol.asyncDispose]();

      // Still only one backend call
      expect(mockBackend.release).toHaveBeenCalledTimes(1);
    });

    it("should handle concurrent disposal with error", async () => {
      const releaseError = new Error("Network failure");
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

      // Launch multiple concurrent disposal calls
      const disposalPromises = [
        handle[Symbol.asyncDispose](),
        handle[Symbol.asyncDispose](),
        handle[Symbol.asyncDispose](),
      ];

      // All should complete without throwing
      await Promise.all(disposalPromises);

      // Backend should be called exactly once
      expect(mockBackend.release).toHaveBeenCalledTimes(1);

      // Error callback should be invoked exactly once
      expect(onReleaseErrorSpy).toHaveBeenCalledTimes(1);
      expect(onReleaseErrorSpy).toHaveBeenCalledWith(releaseError, {
        lockId: "test-lock-concurrent",
        key: "test-key",
        source: "disposal",
      });
    });

    it("should handle rapid sequential disposal calls", async () => {
      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      // Call disposal many times sequentially
      for (let i = 0; i < 10; i++) {
        await handle[Symbol.asyncDispose]();
      }

      // Backend should be called exactly once
      expect(mockBackend.release).toHaveBeenCalledTimes(1);
    });

    it("should handle disposal called during slow release", async () => {
      // Mock release to be very slow (200ms)
      (mockBackend.release as ReturnType<typeof mock>).mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ ok: true }), 200),
          ),
      );

      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      // Start disposal
      const firstDisposal = handle[Symbol.asyncDispose]();

      // Wait a bit, then call disposal again multiple times
      await Bun.sleep(50);
      const secondDisposal = handle[Symbol.asyncDispose]();
      const thirdDisposal = handle[Symbol.asyncDispose]();

      // All should complete successfully
      await Promise.all([firstDisposal, secondDisposal, thirdDisposal]);

      // Backend should be called exactly once
      expect(mockBackend.release).toHaveBeenCalledTimes(1);
    });
  });

  describe("Integration with await using", () => {
    it("should support await using pattern for successful acquisition", async () => {
      const successResult: AcquireResult<
        BackendCapabilities & { supportsFencing: true }
      > = {
        ok: true,
        lockId: "test-lock-bbb",
        expiresAtMs: Date.now() + 30000,
        fence: "000000000000006",
      };

      const decorated = decorateAcquireResult(
        mockBackend,
        successResult,
        "test-key",
      ) as AsyncDisposable & typeof successResult;

      // Simulate await using block
      {
        await using lock = decorated;

        if (lock.ok) {
          // Do work with lock
          expect(lock.lockId).toBe("test-lock-bbb");
        }
      }

      // Disposal should have been called automatically
      expect(mockBackend.release).toHaveBeenCalledWith({
        lockId: "test-lock-bbb",
      });
    });

    it("should support await using pattern for failed acquisition", async () => {
      const failResult: AcquireResult<
        BackendCapabilities & { supportsFencing: true }
      > = {
        ok: false,
        reason: "locked",
      };

      const decorated = decorateAcquireResult(
        mockBackend,
        failResult,
        "test-key",
      ) as AsyncDisposable & typeof failResult;

      // Simulate await using block
      {
        await using lock = decorated;

        if (!lock.ok) {
          // Failed acquisition - no work
          expect(lock.reason).toBe("locked");
        }
      }

      // No release should be called for failed acquisition
      expect(mockBackend.release).not.toHaveBeenCalled();
    });

    it("should dispose even if scope exits with error", async () => {
      const successResult: AcquireResult<
        BackendCapabilities & { supportsFencing: true }
      > = {
        ok: true,
        lockId: "test-lock-ccc",
        expiresAtMs: Date.now() + 30000,
        fence: "000000000000007",
      };

      const decorated = decorateAcquireResult(
        mockBackend,
        successResult,
        "test-key",
      ) as AsyncDisposable & typeof successResult;

      const userError = new Error("User code failed");

      const testFn = async () => {
        await using lock = decorated;

        if (lock.ok) {
          throw userError;
        }
      };

      await expect(testFn()).rejects.toThrow("User code failed");

      // Disposal should still happen despite error
      expect(mockBackend.release).toHaveBeenCalledWith({
        lockId: "test-lock-ccc",
      });
    });
  });
});
