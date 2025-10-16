# API Reference

Complete reference for SyncGuard's public API. For concepts and patterns, see the [Guide](/what-is-syncguard).

::: tip For Library Authors & Contributors
This page documents the public API. For technical specifications and backend implementation requirements, see the [specs directory](https://github.com/kriasoft/syncguard/tree/main/specs) on GitHub.
:::

## Primary API

### `lock()`

Auto-managed distributed lock with retry logic and automatic release.

```typescript
function lock<T>(
  fn: () => Promise<T> | T,
  config: LockConfig & { acquisition?: AcquisitionOptions },
): Promise<T>;
```

**Usage:**

```typescript
import { lock } from "syncguard";

// Basic usage
await lock(
  async () => {
    // Critical section
  },
  { key: "resource:123" },
);

// With configuration
await lock(workFn, {
  key: "job:daily-report",
  ttlMs: 60000, // Lock expires after 60s
  timeoutMs: 10000, // Give up acquisition after 10s
  maxRetries: 20, // Retry up to 20 times
});
```

**Behavior:**

- Acquires lock with automatic retry (exponential backoff with jitter)
- Executes function after successful acquisition
- Releases lock in finally block (even if function throws)
- Throws `LockError` if acquisition times out or encounters system errors
- Function errors propagate normally (not masked by release errors)

See [Core Concepts](/core-concepts#retry-strategy) for retry configuration details.

---

### `createLock()` <Badge type="info" text="syncguard/redis" /> <Badge type="info" text="syncguard/postgres" /> <Badge type="info" text="syncguard/firestore" />

Factory for backend-specific auto-managed lock functions.

::: code-group

```typescript [Redis]
import { createLock } from "syncguard/redis";
import Redis from "ioredis";

const redis = new Redis();
const lock = createLock(redis, {
  keyPrefix: "my-app", // Default: "syncguard"
});

await lock(workFn, { key: "resource:123" });
```

```typescript [PostgreSQL]
import { createLock, setupSchema } from "syncguard/postgres";
import postgres from "postgres";

const sql = postgres("postgresql://localhost:5432/myapp");

// Setup schema (once, during initialization)
await setupSchema(sql, {
  tableName: "app_locks",
  fenceTableName: "app_fence_counters",
});

// Create lock function (synchronous)
const lock = createLock(sql, {
  tableName: "app_locks", // Default: "syncguard_locks"
  fenceTableName: "app_fence_counters", // Default: "syncguard_fence_counters"
});

await lock(workFn, { key: "resource:123" });
```

```typescript [Firestore]
import { createLock } from "syncguard/firestore";
import { Firestore } from "@google-cloud/firestore";

const db = new Firestore();
const lock = createLock(db, {
  collection: "app_locks", // Default: "locks"
  fenceCollection: "app_fences", // Default: "fence_counters"
});

await lock(workFn, { key: "resource:123" });
```

:::

**When to use:** Configure backend once, reuse lock function across your application.

---

## Backend Interface

For manual lock control with custom retry logic or long-running tasks.

### `createRedisBackend()` <Badge type="info" text="syncguard/redis" />

```typescript
import { createRedisBackend } from "syncguard/redis";
import Redis from "ioredis";

const redis = new Redis();
const backend = createRedisBackend(redis, {
  keyPrefix: "syncguard",
  cleanupInIsLocked: false,
});
```

See [Redis Backend](/redis) for configuration details.

---

### `createFirestoreBackend()` <Badge type="info" text="syncguard/firestore" />

```typescript
import { createFirestoreBackend } from "syncguard/firestore";
import { Firestore } from "@google-cloud/firestore";

const db = new Firestore();
const backend = createFirestoreBackend(db, {
  collection: "locks",
  fenceCollection: "fence_counters",
  cleanupInIsLocked: false,
});
```

::: tip Index Required
Firestore requires a single-field ascending index on the `lockId` field for optimal performance. See [Firestore Backend](/firestore) for details.
:::

---

### `backend.acquire()`

Request exclusive lock on a resource.

```typescript
acquire(opts: {
  key: string;
  ttlMs: number;
  signal?: AbortSignal;
}): Promise<AcquireResult<C>>;
```

**Usage:**

```typescript
const result = await backend.acquire({
  key: "payment:123",
  ttlMs: 30000, // Lock expires after 30s
});

if (result.ok) {
  const { lockId, expiresAtMs, fence } = result;
  // You now hold the lock
} else {
  // result.reason === "locked" (another process holds it)
}
```

**Returns:**

- Success: `{ ok: true, lockId, expiresAtMs, fence }`
- Contention: `{ ok: false, reason: "locked" }`
- System errors throw `LockError`

**Notes:**

- Single-attempt operation (no automatic retry)
- `fence` is guaranteed present for Redis/Firestore backends (compile-time type safety)
- `lockId` is required for all subsequent operations (release, extend, lookup)

See [Fencing Tokens](/fencing) for fence token usage patterns.

---

### `backend.release()`

Release lock ownership.

```typescript
release(opts: {
  lockId: string;
  signal?: AbortSignal;
}): Promise<ReleaseResult>;
```

**Usage:**

```typescript
const released = await backend.release({ lockId });

if (released.ok) {
  // Lock successfully released
} else {
  // Lock was already expired/released
}
```

**Returns:**

- Success: `{ ok: true }`
- Failure: `{ ok: false }` (lock was expired, not found, or ownership mismatch)
- System errors throw `LockError`

**Notes:**

- Idempotent: safe to call even if lock is expired/released
- Only the owner (matching `lockId`) can release
- Failed release means lock was absent (expired or never existed)

---

### `backend.extend()`

Extend lock TTL before expiration.

```typescript
extend(opts: {
  lockId: string;
  ttlMs: number;
  signal?: AbortSignal;
}): Promise<ExtendResult>;
```

**Usage:**

```typescript
const extended = await backend.extend({
  lockId,
  ttlMs: 60000, // Reset to 60s from now
});

if (extended.ok) {
  console.log(`Lock now expires at ${new Date(extended.expiresAtMs)}`);
} else {
  console.log("Lost lock ownership");
}
```

**Returns:**

- Success: `{ ok: true, expiresAtMs }` (new expiration time)
- Failure: `{ ok: false }` (lock was expired or not found)
- System errors throw `LockError`

**Notes:**

- **Replaces TTL entirely** (doesn't add to remaining time)
- Returns `expiresAtMs` for heartbeat scheduling
- Cannot resurrect expired locks (use `acquire()` instead)
- Idempotent: safe to call even if lock is expired

::: warning TTL Replacement
`extend({ lockId, ttlMs: 60000 })` sets expiration to 60s from **now**, not from the original acquisition. See [Core Concepts](/core-concepts#ttl--expiration).
:::

---

### `backend.isLocked()`

Check if resource is currently locked (simple boolean).

```typescript
isLocked(opts: {
  key: string;
  signal?: AbortSignal;
}): Promise<boolean>;
```

**Usage:**

```typescript
const locked = await backend.isLocked({ key: "resource:123" });

if (locked) {
  console.log("Resource is locked by someone");
} else {
  console.log("Resource is available");
}
```

**Returns:**

- `true` if actively locked
- `false` if not locked or expired

**Notes:**

- Read-only operation (no side effects)
- Does not reveal lock owner or expiration time
- For detailed info, use `backend.lookup()` or `getByKey()` helper

---

### `backend.lookup()`

Lower-level diagnostic method for detailed lock information.

```typescript
// By key (O(1) direct access)
lookup(opts: { key: string; signal?: AbortSignal }): Promise<LockInfo<C> | null>;

// By lockId (reverse lookup + verification)
lookup(opts: { lockId: string; signal?: AbortSignal }): Promise<LockInfo<C> | null>;
```

::: info Prefer Helper Functions
For better discoverability and clearer intent, use the diagnostic helpers instead: `getByKey()`, `getById()`, and `owns()`. These provide a more ergonomic API while calling `lookup()` internally. See [Diagnostics & Helpers](#diagnostics-helpers) for recommended usage patterns.
:::

**Usage:**

```typescript
// Check resource status
const info = await backend.lookup({ key: "resource:123" });
if (info) {
  console.log(`Expires at ${new Date(info.expiresAtMs)}`);
  console.log(`Fence: ${info.fence}`);
}

// Check ownership
const owned = await backend.lookup({ lockId });
if (owned) {
  console.log("Still own the lock");
}
```

**Returns:**

- `LockInfo<C>` if lock exists and is not expired
- `null` if not found or expired (no distinction)

**Notes:**

- Returns sanitized data (hashed keys/lockIds)
- For raw data access, use `getByKeyRaw()` or `getByIdRaw()` helpers
- Read-only operation (no side effects)
- Includes `fence` for fencing-capable backends
- **Atomicity:** Redis uses atomic Lua scripts for lockId lookup (multi-key reads); Firestore uses non-atomic indexed queries with post-read verification (per ADR-011, both approaches ensure portability for diagnostic use)

::: warning Diagnostic Use Only
Lookup is for **diagnostics, UI, and monitoring** — NOT a correctness guard. Never use `lookup() → mutate` patterns. Correctness relies on atomic ownership verification built into `release()` and `extend()` operations (ADR-003).
:::

---

### `backend.capabilities`

Backend capability introspection.

```typescript
interface BackendCapabilities {
  supportsFencing: boolean;
  timeAuthority: "server" | "client";
}
```

**Usage:**

```typescript
const backend = createRedisBackend(redis);

console.log(backend.capabilities.supportsFencing); // true (Redis always provides fences)
console.log(backend.capabilities.timeAuthority); // "server" (Redis uses server time)
```

**Redis:** `{ supportsFencing: true, timeAuthority: "server" }`
**PostgreSQL:** `{ supportsFencing: true, timeAuthority: "server" }`
**Firestore:** `{ supportsFencing: true, timeAuthority: "client" }`

---

## Result Types

### `AcquireResult<C>`

Discriminated union for acquisition outcomes.

```typescript
type AcquireResult<C extends BackendCapabilities> =
  | {
      ok: true;
      lockId: string;
      expiresAtMs: number;
      fence: Fence; // Required when C['supportsFencing'] === true
    }
  | {
      ok: false;
      reason: "locked";
    };
```

**Pattern matching:**

```typescript
const result = await backend.acquire({ key: "resource:123", ttlMs: 30000 });

if (result.ok) {
  // TypeScript knows: lockId, expiresAtMs, fence are available
  const { lockId, fence } = result;
} else {
  // TypeScript knows: reason is "locked"
  console.log("Contention:", result.reason);
}
```

---

### `ReleaseResult`

Simple success/failure result.

```typescript
type ReleaseResult = { ok: true } | { ok: false };
```

**Interpretation:**

- `{ ok: true }`: Lock successfully released
- `{ ok: false }`: Lock was absent (expired or never existed)

---

### `ExtendResult`

Extension result with new expiration time.

```typescript
type ExtendResult = { ok: true; expiresAtMs: number } | { ok: false };
```

**Usage:**

```typescript
const extended = await backend.extend({ lockId, ttlMs: 60000 });

if (extended.ok) {
  // Schedule next heartbeat based on new expiration
  const nextHeartbeat = extended.expiresAtMs - Date.now() - 5000;
}
```

---

### `LockInfo<C>`

Sanitized lock information (returned by `lookup()`).

```typescript
type LockInfo<C extends BackendCapabilities> = {
  keyHash: HashId; // SHA-256 hash (24 hex chars)
  lockIdHash: HashId;
  expiresAtMs: number; // Unix timestamp
  acquiredAtMs: number;
  fence: Fence; // Required when C['supportsFencing'] === true
};
```

**Security note:** `lookup()` returns hashed identifiers to prevent accidental logging of sensitive keys/lockIds. For debugging, use `getByKeyRaw()` or `getByIdRaw()`.

---

### `LockInfoDebug<C>`

Extended lock info with raw keys/lockIds (via `getByKeyRaw()`/`getByIdRaw()` helpers).

```typescript
interface LockInfoDebug<C extends BackendCapabilities> extends LockInfo<C> {
  key: string; // Raw key (use in dev/debug only)
  lockId: string; // Raw lockId
}
```

---

### `Fence`

Fencing token type (15-digit zero-padded string per ADR-004).

```typescript
type Fence = string; // e.g., "000000000000001"
```

**Properties:**

- Lexicographic ordering matches chronological order
- Direct string comparison works: `fenceA > fenceB`
- JSON-safe (no BigInt precision issues)
- Cross-backend consistent format (15 digits)
- Guarantees full safety within Lua's 53-bit precision (2^53-1 ≈ 9.007e15)

**Usage:**

```typescript
const fences = ["000000000000003", "000000000000001"];
const sorted = fences.sort(); // ["000000000000001", "000000000000003"] - lexicographic = chronological

if (newFence > storedFence) {
  // Accept write from newer lock holder
}
```

See [Fencing Tokens](/fencing) for complete usage guide.

---

## Configuration

### `LockConfig`

Configuration for `lock()` function.

```typescript
interface LockConfig {
  key: string; // Required: unique lock identifier
  ttlMs?: number; // Lock expiration (default: 30000ms)
  signal?: AbortSignal; // Cancel in-flight operations
  onReleaseError?: (
    error: Error,
    context: { lockId: string; key: string },
  ) => void;
  acquisition?: AcquisitionOptions; // Retry strategy
}
```

**Example:**

```typescript
await lock(workFn, {
  key: "job:daily-report",
  ttlMs: 60000,
  timeoutMs: 10000,
  maxRetries: 20,
  onReleaseError: (err, ctx) => {
    console.error(`Failed to release ${ctx.key}:`, err);
  },
});
```

**Fields:**

| Field            | Type                 | Default      | Description                            |
| ---------------- | -------------------- | ------------ | -------------------------------------- |
| `key`            | `string`             | _(required)_ | Unique lock identifier (max 512 bytes) |
| `ttlMs`          | `number`             | `30000`      | Lock expiration in milliseconds        |
| `signal`         | `AbortSignal`        | `undefined`  | Cancel lock operations                 |
| `onReleaseError` | `function`           | `undefined`  | Handle release errors (optional)       |
| `acquisition`    | `AcquisitionOptions` | See below    | Retry strategy                         |

---

### `AcquisitionOptions`

Retry strategy for lock acquisition.

```typescript
interface AcquisitionOptions {
  maxRetries?: number; // Default: 10
  retryDelayMs?: number; // Base delay, default: 100ms
  backoff?: "exponential" | "fixed"; // Default: "exponential"
  jitter?: "equal" | "full" | "none"; // Default: "equal"
  timeoutMs?: number; // Hard limit, default: 5000ms
  signal?: AbortSignal; // Abort acquisition loop
}
```

**Defaults:**

```typescript
{
  maxRetries: 10,
  retryDelayMs: 100,
  backoff: "exponential",
  jitter: "equal",
  timeoutMs: 5000
}
```

**Example:**

```typescript
// More patient (high contention tolerance)
await lock(workFn, {
  key: "hot-resource",
  acquisition: {
    maxRetries: 20,
    timeoutMs: 10000,
  },
});

// Fail fast
await lock(workFn, {
  key: "quick-check",
  acquisition: {
    maxRetries: 3,
    timeoutMs: 1000,
  },
});
```

See [Core Concepts](/core-concepts#retry-strategy) for retry behavior details.

---

### Backend Options

#### `RedisBackendOptions` <Badge type="info" text="syncguard/redis" />

```typescript
interface RedisBackendOptions {
  keyPrefix?: string; // Default: "syncguard"
  cleanupInIsLocked?: boolean; // Default: false
}
```

**Usage:**

```typescript
const backend = createRedisBackend(redis, {
  keyPrefix: "my-app", // Keys: "my-app:resource:123"
  cleanupInIsLocked: true, // Optional cleanup in isLocked()
});
```

See [Redis Backend](/redis#configuration-options) for details.

---

#### `FirestoreBackendOptions` <Badge type="info" text="syncguard/firestore" />

```typescript
interface FirestoreBackendOptions {
  collection?: string; // Default: "locks"
  fenceCollection?: string; // Default: "fence_counters"
  cleanupInIsLocked?: boolean; // Default: false
}
```

**Usage:**

```typescript
const backend = createFirestoreBackend(db, {
  collection: "app_locks",
  fenceCollection: "app_fences",
  cleanupInIsLocked: true, // Optional cleanup in isLocked()
});
```

See [Firestore Backend](/firestore#backend-configuration) for details.

---

#### `PostgresBackendOptions` <Badge type="info" text="syncguard/postgres" />

```typescript
interface PostgresBackendOptions {
  tableName?: string; // Default: "syncguard_locks"
  fenceTableName?: string; // Default: "syncguard_fence_counters"
  cleanupInIsLocked?: boolean; // Default: false
}
```

**Usage:**

```typescript
import { setupSchema, createPostgresBackend } from "syncguard/postgres";

// Setup schema (once)
await setupSchema(sql, {
  tableName: "app_locks",
  fenceTableName: "app_fence_counters",
});

// Create backend (synchronous)
const backend = createPostgresBackend(sql, {
  tableName: "app_locks",
  fenceTableName: "app_fence_counters",
  cleanupInIsLocked: true, // Optional cleanup in isLocked()
});
```

See [PostgreSQL Backend](/postgres#backend-configuration) for details.

---

## Diagnostics & Helpers

**Recommended diagnostic API** — These helper functions provide the most ergonomic way to inspect lock state. They offer better discoverability and clearer intent than calling `backend.lookup()` directly.

### `getByKey()`

Lookup lock by resource key (sanitized data). **Primary method** for checking resource lock status.

```typescript
function getByKey<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  key: string,
  opts?: { signal?: AbortSignal },
): Promise<LockInfo<C> | null>;
```

**Usage:**

```typescript
import { getByKey } from "syncguard";

const info = await getByKey(backend, "resource:123");
if (info) {
  console.log(`Lock expires in ${info.expiresAtMs - Date.now()}ms`);
  console.log(`Fence: ${info.fence}`);
} else {
  console.log("Resource is not locked");
}
```

**Use this when:** You need to check if a resource is locked and get detailed information about the lock holder.

---

### `getById()`

Lookup lock by lockId (sanitized data). **Primary method** for checking lock ownership.

```typescript
function getById<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  lockId: string,
  opts?: { signal?: AbortSignal },
): Promise<LockInfo<C> | null>;
```

**Usage:**

```typescript
import { getById } from "syncguard";

const info = await getById(backend, lockId);
if (info) {
  console.log("Own the lock, fence:", info.fence);
  console.log(`Expires in ${info.expiresAtMs - Date.now()}ms`);
} else {
  console.log("No longer own the lock");
}
```

**Use this when:** You need detailed information about a lock you're holding, including expiration time and fence tokens.

---

### `owns()`

Quick boolean ownership check. **Simplified method** for yes/no ownership questions.

```typescript
function owns<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  lockId: string,
): Promise<boolean>;
```

::: warning Diagnostic Use Only
This is for **diagnostics, UI, and monitoring** — NOT a correctness guard. Never use `owns() → mutate` patterns. Correctness relies on atomic ownership verification built into `release()` and `extend()` operations (ADR-003).
:::

**Usage:**

```typescript
import { owns } from "syncguard";

if (await owns(backend, lockId)) {
  console.log("Still own the lock");
} else {
  console.log("Lost ownership");
}
```

**Use this when:** You only need a boolean answer about ownership and don't need additional details.

**Equivalent to:** `!!(await backend.lookup({ lockId }))`

---

::: tip Lower-Level Access
These helpers call `backend.lookup()` internally. For advanced use cases requiring direct access to the backend method, you can use `backend.lookup({ key })` or `backend.lookup({ lockId })` directly.
:::

---

### `getByKeyRaw()`

Lookup lock by key with raw identifiers (debugging).

```typescript
function getByKeyRaw<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  key: string,
  opts?: { signal?: AbortSignal },
): Promise<LockInfoDebug<C> | null>;
```

**Usage:**

```typescript
import { getByKeyRaw } from "syncguard";

const debug = await getByKeyRaw(backend, "resource:123");
if (debug) {
  console.log("Raw key:", debug.key); // Original key
  console.log("Raw lockId:", debug.lockId); // Original lockId
}
```

::: warning Security
Use only in development/debugging. Avoid logging raw keys/lockIds in production to prevent accidental exposure of sensitive identifiers.
:::

---

### `getByIdRaw()`

Lookup lock by lockId with raw identifiers (debugging).

```typescript
function getByIdRaw<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  lockId: string,
  opts?: { signal?: AbortSignal },
): Promise<LockInfoDebug<C> | null>;
```

---

## Error Handling

### `LockError`

Structured error for system failures.

```typescript
class LockError extends Error {
  code:
    | "ServiceUnavailable"
    | "AuthFailed"
    | "InvalidArgument"
    | "RateLimited"
    | "NetworkTimeout"
    | "AcquisitionTimeout"
    | "Internal";
  context?: {
    key?: string;
    lockId?: string;
    cause?: unknown;
  };
}
```

**Usage:**

```typescript
import { LockError } from "syncguard";

try {
  await lock(workFn, { key: "resource:123" });
} catch (error) {
  if (error instanceof LockError) {
    console.error(`[${error.code}] ${error.message}`);

    // Handle specific codes
    switch (error.code) {
      case "AcquisitionTimeout":
        // Couldn't acquire lock within timeoutMs
        break;
      case "ServiceUnavailable":
        // Backend unavailable, retry later
        break;
      case "NetworkTimeout":
        // Client-side timeout
        break;
    }
  }
}
```

**Error codes:**

| Code                 | Cause                               | Action                                |
| -------------------- | ----------------------------------- | ------------------------------------- |
| `AcquisitionTimeout` | Exceeded `timeoutMs` after retries  | Reduce contention or increase timeout |
| `ServiceUnavailable` | Backend unavailable                 | Retry with backoff                    |
| `NetworkTimeout`     | Client/network timeout              | Check network connectivity            |
| `InvalidArgument`    | Malformed key/lockId                | Validate input parameters             |
| `AuthFailed`         | Authentication failure              | Check credentials                     |
| `RateLimited`        | Backend rate limiting               | Implement backoff                     |
| `Aborted`            | Operation cancelled via AbortSignal | User-initiated cancellation           |
| `Internal`           | Unexpected backend error            | Check logs, report if persistent      |

**Notes:**

- Lock contention is **not an error** (returns `{ ok: false, reason: "locked" }`)
- `AcquisitionTimeout` only thrown by `lock()` helper (not `backend.acquire()`)
- System errors include context (key, lockId, cause) when available

---

## Telemetry

### `withTelemetry()`

Opt-in observability decorator for lock operations.

```typescript
function withTelemetry<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  options: TelemetryOptions,
): LockBackend<C>;
```

**Usage:**

```typescript
import { withTelemetry, createRedisBackend } from "syncguard";

const backend = createRedisBackend(redis);
const observed = withTelemetry(backend, {
  onEvent: (event) => {
    console.log("Lock event:", event.type, event.result);
  },
  includeRaw: false, // Redact raw keys/lockIds (default)
});

await observed.acquire({ key: "resource:123", ttlMs: 30000 });
// → { type: "acquire", result: "ok", keyHash: "...", ... }
```

**Options:**

```typescript
interface TelemetryOptions {
  onEvent: (event: LockEvent) => void;
  includeRaw?: boolean | ((event: LockEvent) => boolean);
}
```

**Event structure:**

```typescript
type LockEvent = {
  type: "acquire" | "release" | "extend" | "isLocked" | "lookup";
  result: "ok" | "fail";
  keyHash?: HashId; // Always included
  lockIdHash?: HashId; // For operations using lockId
  reason?: "expired" | "not-found" | "locked"; // Best-effort detail
  key?: string; // Only if includeRaw allows
  lockId?: string; // Only if includeRaw allows
};
```

**Notes:**

- Zero-cost when not applied (no overhead in core backends)
- Events emitted asynchronously (never block operations)
- Default redaction (`includeRaw: false`) prevents accidental exposure
- `reason` field provides operational insights (expired vs not-found)

::: warning Privacy
Set `includeRaw: true` only in development/debugging. Raw keys/lockIds may contain sensitive data (user IDs, payment IDs, etc.).
:::

---

## Type Utilities

### `hasFence()`

Type guard for fencing token presence.

```typescript
function hasFence<C extends BackendCapabilities>(
  result: AcquireResult<C>,
): result is AcquireOk<C> & { fence: Fence };
```

**Usage:**

```typescript
import { hasFence } from "syncguard";

// Generic function accepting unknown backend types
function processWithAnyBackend<C extends BackendCapabilities>(
  result: AcquireResult<C>,
) {
  if (hasFence(result)) {
    // Type guard for generic contexts
    console.log("Fence:", result.fence);
  }
}
```

**Note:** Most application code uses typed backends (Redis/PostgreSQL/Firestore) and doesn't need `hasFence()` since TypeScript knows `fence` exists at compile-time.

---

### `validateLockId()`

Client-side validation for lockId format.

```typescript
function validateLockId(lockId: string): void;
```

**Usage:**

```typescript
import { validateLockId } from "syncguard";

try {
  validateLockId(userProvidedLockId);
  await backend.release({ lockId: userProvidedLockId });
} catch (error) {
  // LockError("InvalidArgument", "Invalid lockId format...")
}
```

**Valid format:** Exactly 22 base64url characters (`^[A-Za-z0-9_-]{22}$`)

---

### `normalizeAndValidateKey()`

Key normalization and validation.

```typescript
function normalizeAndValidateKey(key: string): string;
```

**Usage:**

```typescript
import { normalizeAndValidateKey } from "syncguard";

const normalized = normalizeAndValidateKey(userKey);
await backend.acquire({ key: normalized, ttlMs: 30000 });
```

**Behavior:**

- Unicode NFC normalization
- UTF-8 byte length validation (max 512 bytes)
- Throws `LockError("InvalidArgument")` if key exceeds limit

---

### `generateLockId()`

Generate cryptographically secure lockId.

```typescript
function generateLockId(): string;
```

**Usage:**

```typescript
import { generateLockId } from "syncguard";

const lockId = generateLockId();
// → "a1b2c3d4e5f6g7h8i9j0k1" (22 base64url chars, 128 bits entropy)
```

**Note:** Used internally by `acquire()`. Rarely needed in application code.

---

### `hashKey()`

SHA-256 hash for sanitized identifiers.

```typescript
function hashKey(value: string): HashId;
```

**Usage:**

```typescript
import { hashKey } from "syncguard";

const hash = hashKey("resource:123");
// → "a1b2c3d4e5f6g7h8i9j0k1l2" (24 hex chars, 96 bits)
```

**Note:** Used internally by `lookup()`. Useful for custom telemetry implementations.

---

### Constants

```typescript
// Backend defaults (TTL only)
const BACKEND_DEFAULTS = {
  ttlMs: 30_000, // 30 seconds
} as const;

// Lock helper defaults (retry config)
const LOCK_DEFAULTS = {
  maxRetries: 10,
  retryDelayMs: 100,
  timeoutMs: 5_000,
  backoff: "exponential",
  jitter: "equal",
} as const;

// Key validation
const MAX_KEY_LENGTH_BYTES = 512;
```

**Usage:**

```typescript
import { BACKEND_DEFAULTS, MAX_KEY_LENGTH_BYTES } from "syncguard";

console.log(BACKEND_DEFAULTS.ttlMs); // 30000
console.log(MAX_KEY_LENGTH_BYTES); // 512
```

::: info Internal Constant
`TIME_TOLERANCE_MS = 1000` is an internal constant used by all backends for consistent liveness checks. It's not exported or user-configurable (ADR-005). Redis, PostgreSQL, and Firestore use the same 1000ms tolerance automatically.
:::
