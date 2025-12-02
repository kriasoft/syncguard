// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { LockBackend } from "../../common/types.js";
import type { FirestoreCapabilities } from "../../firestore/types.js";
import type { PostgresCapabilities } from "../../postgres/types.js";
import type { RedisCapabilities } from "../../redis/types.js";
import {
  firestoreFixture,
  type FirestoreFixture,
} from "./firestore.fixture.js";
import { postgresFixture, type PostgresFixture } from "./postgres.fixture.js";
import { redisFixture, type RedisFixture } from "./redis.fixture.js";

/**
 * Backend fixture interface with lifecycle methods.
 */
export type BackendFixture = RedisFixture | PostgresFixture | FirestoreFixture;

/**
 * Backend fixture result after setup.
 */
export interface BackendFixtureResult {
  name: string;
  kind: "redis" | "postgres" | "firestore";
  backend:
    | LockBackend<RedisCapabilities>
    | LockBackend<PostgresCapabilities>
    | LockBackend<FirestoreCapabilities>;
  cleanup(): Promise<void>;
  teardown(): Promise<void>;
}

/**
 * All available backend fixtures.
 */
export const backends: BackendFixture[] = [
  redisFixture,
  postgresFixture,
  firestoreFixture,
];

/**
 * Get backends enabled via environment variables.
 * Returns all backends if no explicit env vars are set.
 *
 * @returns Array of enabled backend fixtures
 */
export function getEnabledBackends(): BackendFixture[] {
  const enabledVars = backends
    .map((b) => b.envVar)
    .filter((v) => process.env[v]?.toLowerCase() === "true");

  // If no explicit enables, return all backends
  if (enabledVars.length === 0) {
    return backends;
  }

  // Return only explicitly enabled backends
  return backends.filter(
    (b) => process.env[b.envVar]?.toLowerCase() === "true",
  );
}

/**
 * Get backends that are both enabled and actually available.
 * Performs async availability checks.
 *
 * @returns Array of available backend fixtures
 */
export async function getAvailableBackends(): Promise<BackendFixture[]> {
  const enabled = getEnabledBackends();

  const availabilityChecks = await Promise.all(
    enabled.map(async (backend) => ({
      backend,
      available: await backend.available(),
    })),
  );

  return availabilityChecks
    .filter((result) => result.available)
    .map((result) => result.backend);
}

/**
 * Setup a backend fixture for testing.
 *
 * @param fixture Backend fixture to setup
 * @returns Backend fixture result with lifecycle methods
 */
export async function setupBackend(
  fixture: BackendFixture,
): Promise<BackendFixtureResult> {
  const result = await fixture.setup();

  return {
    name: fixture.name,
    kind: fixture.kind,
    backend: result.createBackend() as
      | LockBackend<RedisCapabilities>
      | LockBackend<PostgresCapabilities>
      | LockBackend<FirestoreCapabilities>,
    cleanup: result.cleanup,
    teardown: result.teardown,
  };
}
