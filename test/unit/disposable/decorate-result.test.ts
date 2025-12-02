// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Unit tests for decorateAcquireResult function
 *
 * Tests the decoration of acquire results with disposal methods including:
 * - Successful acquisition decoration
 * - Failed acquisition decoration with no-op methods
 * - Type narrowing and discriminated unions
 * - Integration with await using pattern
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
import { decorateAcquireResult } from "../../../common/disposable.js";
import type {
  AcquireResult,
  BackendCapabilities,
  ExtendResult,
  LockBackend,
  OnReleaseError,
  ReleaseResult,
} from "../../../common/types.js";

describe("decorateAcquireResult", () => {
  let mockBackend: Pick<
    LockBackend<BackendCapabilities & { supportsFencing: true }>,
    "release" | "extend"
  >;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

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
