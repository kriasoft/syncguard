// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Unit tests for createDisposableHandle function
 *
 * Tests the basic creation and functionality of disposable handles including:
 * - Handle creation with disposal methods
 * - Manual release() and extend() operations
 * - AbortSignal support
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
  ReleaseResult,
} from "../../../common/types.js";

describe("createDisposableHandle", () => {
  let mockBackend: Pick<
    LockBackend<BackendCapabilities & { supportsFencing: true }>,
    "release" | "extend"
  >;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  const mockAcquireResult: AcquireOk<
    BackendCapabilities & { supportsFencing: true }
  > = {
    ok: true,
    lockId: "test-lock-123",
    expiresAtMs: Date.now() + 30000,
    fence: "000000000000001",
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

  describe("AbortSignal Support", () => {
    it("should forward signal to backend.release()", async () => {
      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      const abortController = new AbortController();
      await handle.release(abortController.signal);

      expect(mockBackend.release).toHaveBeenCalledWith({
        lockId: "test-lock-123",
        signal: abortController.signal,
      });
    });

    it("should forward signal to backend.extend()", async () => {
      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      const abortController = new AbortController();
      await handle.extend(15000, abortController.signal);

      expect(mockBackend.extend).toHaveBeenCalledWith({
        lockId: "test-lock-123",
        ttlMs: 15000,
        signal: abortController.signal,
      });
    });

    it("should work without signal parameter (backward compatibility)", async () => {
      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      // Call without signal parameter
      await handle.release();

      expect(mockBackend.release).toHaveBeenCalledWith({
        lockId: "test-lock-123",
        signal: undefined,
      });
    });

    it("should allow different signals for release and extend", async () => {
      const handle = createDisposableHandle(
        mockBackend,
        mockAcquireResult,
        "test-key",
      );

      const extendController = new AbortController();
      await handle.extend(10000, extendController.signal);

      expect(mockBackend.extend).toHaveBeenCalledWith({
        lockId: "test-lock-123",
        ttlMs: 10000,
        signal: extendController.signal,
      });

      // Now release with a different signal
      const releaseController = new AbortController();
      await handle.release(releaseController.signal);

      expect(mockBackend.release).toHaveBeenCalledWith({
        lockId: "test-lock-123",
        signal: releaseController.signal,
      });
    });
  });
});
