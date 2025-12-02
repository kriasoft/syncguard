// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Unit tests for disposal timeout behavior
 *
 * Tests the disposal timeout mechanism including:
 * - Abort disposal after timeout
 * - No timeout when release completes quickly
 * - No timeout when disposeTimeoutMs is undefined
 * - Timeout with decorateAcquireResult
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
} from "../../../common/disposable.js";
import type {
  AcquireOk,
  AcquireResult,
  BackendCapabilities,
  ExtendResult,
  LockBackend,
  OnReleaseError,
  ReleaseResult,
} from "../../../common/types.js";

describe("Disposal Timeout", () => {
  let mockBackend: Pick<
    LockBackend<BackendCapabilities & { supportsFencing: true }>,
    "release" | "extend"
  >;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  const mockAcquireResult: AcquireOk<
    BackendCapabilities & { supportsFencing: true }
  > = {
    ok: true,
    lockId: "test-lock-timeout",
    expiresAtMs: Date.now() + 30000,
    fence: "000000000000099",
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

  it("should abort disposal after timeout", async () => {
    const onReleaseErrorSpy = mock<OnReleaseError>();

    // Mock release to hang indefinitely (respects abort signal)
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

    // Stub setTimeout: captures scheduled delay and callback. Without this,
    // the test can't verify the timeout value and relies on wall-clock timing.
    let timeoutCallback: any = null;
    let capturedDelay = 0;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout")
      // @ts-expect-error - Mocking setTimeout for test purposes
      .mockImplementation((callback: any, delay: any) => {
        timeoutCallback = callback;
        capturedDelay = delay;
        return 0; // Return dummy timer ID
      });

    // Kick off disposal (which schedules the timeout)
    const disposalPromise = handle[Symbol.asyncDispose]();

    // Verify timeout was scheduled for exactly 100ms (catches regressions
    // if timeout value is changed or accidentally removed)
    expect(capturedDelay).toBe(100);
    expect(timeoutCallback).not.toBeNull();

    // Manually invoke the timeout callback (keeps test deterministic and fast)
    timeoutCallback();

    // Await disposal completion
    await disposalPromise;

    // Verify timeout worked: error callback should be invoked
    expect(onReleaseErrorSpy).toHaveBeenCalledTimes(1);
    const [error, context] = onReleaseErrorSpy.mock.calls[0]!;
    expect(error.message).toContain("timed out");
    expect(context).toEqual({
      lockId: "test-lock-timeout",
      key: "test-key",
      source: "disposal",
    });

    setTimeoutSpy.mockRestore();
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

    // Disposal completes without timeout
    const startTime = Date.now();
    await handle[Symbol.asyncDispose]();
    const elapsed = Date.now() - startTime;

    // Key assertions:
    // 1. No error callback invoked (release succeeded, no timeout)
    expect(onReleaseErrorSpy).not.toHaveBeenCalled();
    // 2. Release completed promptly (< 100ms, well under 1s timeout)
    expect(elapsed).toBeLessThan(100);
  });

  it("should not apply timeout when disposeTimeoutMs is undefined", async () => {
    const onReleaseErrorSpy = mock<OnReleaseError>();

    let releaseResolver: ((value: ReleaseResult) => void) | undefined;
    (mockBackend.release as ReturnType<typeof mock>).mockImplementation(
      () =>
        new Promise<ReleaseResult>((resolve) => {
          releaseResolver = resolve;
        }),
    );

    const handle = createDisposableHandle(
      mockBackend,
      mockAcquireResult,
      "test-key",
      onReleaseErrorSpy,
      undefined, // no timeout
    );

    let setTimeoutCalled = false;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout")
      // @ts-expect-error - Mocking setTimeout for test purposes
      .mockImplementation((callback: any, delay?: number) => {
        setTimeoutCalled = true;
        return 0;
      });

    const disposalPromise = handle[Symbol.asyncDispose]();

    expect(mockBackend.release).toHaveBeenCalledWith({
      lockId: "test-lock-timeout",
    });
    expect(releaseResolver).toBeDefined();

    // Manually resolve release to keep test deterministic
    releaseResolver!({ ok: true });
    await disposalPromise;

    // No timer indicates disposeTimeoutMs was not applied
    expect(onReleaseErrorSpy).not.toHaveBeenCalled();
    expect(setTimeoutCalled).toBe(false);

    setTimeoutSpy.mockRestore();
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

  it("should invoke error callback when release fails before timeout", async () => {
    const onReleaseErrorSpy = mock<OnReleaseError>();
    const releaseError = new Error("Connection refused");

    // Release fails immediately (before timeout would trigger)
    (mockBackend.release as ReturnType<typeof mock>).mockRejectedValue(
      releaseError,
    );

    const handle = createDisposableHandle(
      mockBackend,
      mockAcquireResult,
      "test-key",
      onReleaseErrorSpy,
      5000, // Long timeout - release fails before it triggers
    );

    await handle[Symbol.asyncDispose]();

    // Error callback should be invoked with the release error
    expect(onReleaseErrorSpy).toHaveBeenCalledTimes(1);
    expect(onReleaseErrorSpy).toHaveBeenCalledWith(releaseError, {
      lockId: "test-lock-timeout",
      key: "test-key",
      source: "disposal",
    });
  });

  it("should invoke error callback for deferred release failure after timeout", async () => {
    const onReleaseErrorSpy = mock<OnReleaseError>();
    const releaseError = new Error("Deferred connection error");

    // Release hangs, then fails after timeout fires
    let rejectRelease: (err: Error) => void;
    (mockBackend.release as ReturnType<typeof mock>).mockImplementation(
      () =>
        new Promise<ReleaseResult>((_, reject) => {
          rejectRelease = reject;
        }),
    );

    const handle = createDisposableHandle(
      mockBackend,
      mockAcquireResult,
      "test-key",
      onReleaseErrorSpy,
      50, // Short timeout
    );

    const disposalPromise = handle[Symbol.asyncDispose]();

    // Wait for timeout to fire
    await Bun.sleep(100);

    // Disposal should complete (timeout fired)
    await disposalPromise;

    // No error yet - release is still pending
    expect(onReleaseErrorSpy).not.toHaveBeenCalled();

    // Now release fails (fire-and-forget path)
    rejectRelease!(releaseError);

    // Give the fire-and-forget handler time to run
    await Bun.sleep(10);

    // Error callback should be invoked for the deferred failure
    expect(onReleaseErrorSpy).toHaveBeenCalledTimes(1);
    expect(onReleaseErrorSpy).toHaveBeenCalledWith(releaseError, {
      lockId: "test-lock-timeout",
      key: "test-key",
      source: "disposal",
    });
  });

  it("should work with decorateAcquireResult", async () => {
    const onReleaseErrorSpy = mock<OnReleaseError>();

    // Mock release to hang (respects abort signal)
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
      // Stub setTimeout: captures scheduled delay and callback. Without this,
      // the test can't verify the timeout value and relies on wall-clock timing.
      let timeoutCallback: any = null;
      let capturedDelay = 0;
      const setTimeoutSpy = spyOn(globalThis, "setTimeout")
        // @ts-expect-error - Mocking setTimeout for test purposes
        .mockImplementation((callback: any, delay: any) => {
          timeoutCallback = callback;
          capturedDelay = delay;
          return 0; // Return dummy timer ID
        });

      // Kick off disposal (which schedules the timeout)
      const disposalPromise = decorated[Symbol.asyncDispose]();

      // Verify timeout was scheduled for exactly 100ms (catches regressions
      // if timeout value is changed or accidentally removed)
      expect(capturedDelay).toBe(100);
      expect(timeoutCallback).not.toBeNull();

      // Manually invoke the timeout callback (keeps test deterministic and fast)
      timeoutCallback();

      // Await disposal completion
      await disposalPromise;

      // Verify timeout worked: error callback should be invoked
      expect(onReleaseErrorSpy).toHaveBeenCalledTimes(1);

      setTimeoutSpy.mockRestore();
    }
  });
});
