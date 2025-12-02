// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Unit tests for concurrent disposal and re-entry
 *
 * Tests concurrent disposal scenarios including:
 * - Concurrent disposal calls only hit backend once
 * - Re-entry during disposal returns same promise
 * - Mix of concurrent disposal and manual release
 * - Concurrent disposal with errors
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

describe("Concurrent Disposal and Re-entry", () => {
  let mockBackend: Pick<
    LockBackend<BackendCapabilities & { supportsFencing: true }>,
    "release" | "extend"
  >;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  const mockAcquireResult: AcquireOk<
    BackendCapabilities & { supportsFencing: true }
  > = {
    ok: true,
    lockId: "test-lock-concurrent",
    expiresAtMs: Date.now() + 30000,
    fence: "000000000000777",
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
        new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 100)),
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
        new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 200)),
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
