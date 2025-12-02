// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Unit tests for disposal idempotency
 *
 * Tests that disposal operations are idempotent including:
 * - Multiple release() calls only hit backend once
 * - Multiple disposal calls only hit backend once
 * - Mixed manual release and disposal only hits backend once
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

describe("Disposal Idempotency", () => {
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
