# Firestore Backend

Distributed locking using Google Cloud Firestore as the backend. Ideal for applications already using Firestore or requiring serverless infrastructure.

## File Structure

```text
firestore/
  backend.ts           → Firestore LockBackend implementation
  index.ts             → Convenience wrapper with Firestore client setup
  config.ts            → Firestore-specific configuration & validation
  types.ts             → Firestore document schemas (LockDocument, etc.)
  errors.ts            → Centralized Firestore error mapping
  operations/
    acquire.ts         → Atomic acquire operation
    release.ts         → Atomic release operation
    extend.ts          → Atomic extend operation
    is-locked.ts       → Lock status check operation
    lookup.ts          → Lock lookup by key/lockId
    index.ts           → Operation exports
```

## Key Design Decisions

### Transaction-Based Atomicity

All mutating operations use Firestore transactions for atomicity:

```typescript
await db.runTransaction(async (trx) => {
  // 1. Capture client time (Firestore uses client time authority)
  const nowMs = Date.now();

  // 2. Read document
  const docRef = db.collection(config.collection).doc(key);
  const snapshot = await trx.get(docRef);

  // 3. Process data and check conditions
  // ...

  // 4. Perform atomic mutations
  await trx.set(docRef, data);

  return result;
});
```

### Dual-Collection Pattern

```text
locks/                          → Main lock documents (collection)
  {key}/                        → Lock document keyed by storage key
    lockId: string              → Unique lock identifier
    expiresAtMs: number         → Expiration timestamp
    acquiredAtMs: number        → Acquisition timestamp
    fence: string               → Fencing token (15-digit zero-padded)
    userKey: string             → Original user key

fence_counters/                 → Persistent fence counters (collection)
  {fenceKey}/                   → Counter document keyed by fence key
    fence: number               → Monotonic counter value
```

### Client Time Authority

Firestore uses client time (`Date.now()`) for all expiration checks. **NTP synchronization is MANDATORY in production** to prevent clock skew issues.

### Required Index

**CRITICAL**: Firestore requires a single-field ascending index on the `lockId` field for optimal performance:

```typescript
// Terraform example
resource "google_firestore_index" "lock_id" {
  collection = "locks"
  fields {
    field_path = "lockId"
    order      = "ASCENDING"
  }
}
```

Firestore typically auto-creates this for equality queries, but verify in production.

## Local Development

### Prerequisites

```bash
# Firestore emulator running on localhost:8080
firebase emulators:start --only firestore

# Or use gcloud:
gcloud emulators firestore start
```

### Testing

```bash
# Unit tests (mocked Firestore client)
bun run test:unit firestore

# Integration tests (requires Firestore emulator)
bun run test:integration firestore
```

## Configuration

```typescript
import { createFirestoreBackend } from "syncguard/firestore";
import { Firestore } from "@google-cloud/firestore";

const db = new Firestore();
const backend = createFirestoreBackend(db, {
  collection: "app_locks", // Default: "locks"
  fenceCollection: "app_fences", // Default: "fence_counters"
  cleanupInIsLocked: false, // Default: false
});
```

## Performance Characteristics

- **Latency**: 10-50ms for remote Firestore (serverless overhead)
- **Throughput**: 100-500 ops/sec (depends on Firestore quotas)
- **Transaction overhead**: Firestore transactions are relatively slow compared to Redis/PostgreSQL

## Clock Synchronization Requirements

**CRITICAL**: Firestore uses client time authority. In production:

1. **Deploy NTP synchronization on ALL clients**
2. **Implement NTP sync monitoring in deployment pipeline**
3. **Add application health checks to detect clock skew**
4. **Fail deployments if NTP sync quality is poor**

See `specs/firestore-backend.md#firestore-clock-sync-requirements` for complete operational requirements.

## Common Patterns

### Index Verification

```typescript
// Verify lockId index exists
const indexes = await db.collection("locks").listIndexes();
const hasLockIdIndex = indexes.some((idx) =>
  idx.fields.some((f) => f.fieldPath === "lockId"),
);

if (!hasLockIdIndex) {
  console.warn("Missing lockId index - performance will be degraded");
}
```

### Cleanup Operations

```typescript
// Count expired locks
const nowMs = Date.now();
const expiredSnapshot = await db
  .collection("locks")
  .where("expiresAtMs", "<", nowMs)
  .get();

console.log(`Expired locks: ${expiredSnapshot.size}`);

// Manual cleanup (optional, if not using cleanupInIsLocked)
const batch = db.batch();
expiredSnapshot.docs.forEach((doc) => batch.delete(doc.ref));
await batch.commit();
```

**WARNING**: NEVER delete from `fence_counters` collection - fence counters must persist indefinitely for fencing safety.

### Duplicate Detection (ADR-014)

Firestore operations that query by `lockId` should detect duplicate documents (defensive guard against data corruption):

```typescript
const snapshot = await db
  .collection(config.collection)
  .where("lockId", "==", lockId)
  .get();

if (snapshot.size > 1) {
  // Log warning - duplicates shouldn't exist but detect if they do
  console.error(`Duplicate lockId documents detected: ${lockId}`);
}
```

## Firestore-Specific Considerations

### No UNIQUE Constraints

Firestore lacks database-level unique indexes on fields. The library relies on:

- Cryptographically strong lockId generation (128 bits entropy)
- Document ID uniqueness for main lock keys
- Defensive duplicate detection in lockId queries

### Transaction Limits

- Max 500 documents per transaction
- Transaction timeout: 60 seconds
- For bulk operations, use batched writes outside transactions

### Cost Optimization

- Use `cleanupInIsLocked: false` (default) to minimize document reads
- Batch cleanup operations to reduce read/write costs
- Monitor document read/write counts in Firebase Console

## Implementation References

- **Specification**: See `specs/firestore-backend.md` for complete implementation requirements
- **Common Interface**: See `specs/interface.md` for shared LockBackend contract
- **ADRs**: See `specs/adrs.md` for architectural decisions
- **Clock Sync Requirements**: See `specs/firestore-backend.md#firestore-clock-sync-requirements`
