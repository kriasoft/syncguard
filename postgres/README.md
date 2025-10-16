# PostgreSQL Backend

Distributed locking using PostgreSQL as the backend. Ideal for applications already using PostgreSQL or requiring ACID transaction guarantees with relational database infrastructure.

## File Structure

```text
postgres/
  backend.ts           → PostgreSQL LockBackend implementation
  index.ts             → Convenience wrapper with PostgreSQL client setup
  config.ts            → PostgreSQL-specific configuration & validation
  types.ts             → PostgreSQL table schemas and row types
  errors.ts            → Centralized PostgreSQL error mapping
  schema.sql           → Table and index definitions (for reference)
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

All mutating operations use `postgres.js` transactions with row-level locking:

```typescript
await sql.begin(async (sql) => {
  // 1. Capture server time inside transaction
  const nowMs = Math.floor(
    Number(
      (await sql`SELECT EXTRACT(EPOCH FROM NOW()) * 1000 AS now_ms`)[0].now_ms,
    ),
  );

  // 2. Read with row-level locks using FOR UPDATE
  const rows = await sql`SELECT * FROM locks WHERE key = ${key} FOR UPDATE`;

  // 3. Process data and check conditions
  // ...

  // 4. Perform atomic mutations
  await sql`INSERT ... ON CONFLICT ... DO UPDATE ...`;

  return result;
});
```

### Dual-Table Pattern

```sql
-- Lock table (main records)
CREATE TABLE syncguard_locks (
  key TEXT PRIMARY KEY,
  lock_id TEXT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  acquired_at_ms BIGINT NOT NULL,
  fence TEXT NOT NULL,
  user_key TEXT NOT NULL
);

-- Fence counter table (persistent counters)
CREATE TABLE syncguard_fence_counters (
  fence_key TEXT PRIMARY KEY,
  fence BIGINT NOT NULL DEFAULT 0
);

-- Required indexes
CREATE UNIQUE INDEX idx_syncguard_locks_lock_id ON syncguard_locks(lock_id);
CREATE INDEX idx_syncguard_locks_expires ON syncguard_locks(expires_at_ms);
```

### Server Time Authority

PostgreSQL uses server time (`EXTRACT(EPOCH FROM NOW()) * 1000`) for all expiration checks, eliminating client clock drift issues (same model as Redis).

### UNIQUE Index on lock_id

- **Reverse lookup**: Enables efficient release/extend/lookup operations by lockId
- **Uniqueness enforcement**: Enforces invariant that each lockId appears at most once
- **Query optimization**: PostgreSQL knows exactly 0 or 1 row matches
- **Defense-in-depth**: Database enforces cryptographically impossible collisions

## Local Development

### Prerequisites

```bash
# PostgreSQL server running on localhost:5432
# Or use Docker:
docker run -d \
  --name syncguard-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  postgres:16-alpine
```

### Schema Setup

**By default, schema is created automatically** when you initialize the backend:

```typescript
import postgres from "postgres";
import { createPostgresBackend } from "syncguard/postgres";

const sql = postgres("postgresql://localhost:5432/myapp");
const backend = await createPostgresBackend(sql);
// Tables and indexes are now created automatically!
```

**Optional: Manual schema creation** (recommended for production deployments):

```bash
# Create schema manually before initializing backend
psql -U postgres -d myapp < postgres/schema.sql

# Then disable auto-creation
const backend = await createPostgresBackend(sql, {
  autoCreateTables: false  // Skip automatic schema creation
});
```

### Testing

```bash
# Unit tests (mocked postgres.js client)
bun run test:unit postgres

# Integration tests (requires PostgreSQL server)
bun run test:integration postgres
```

## Configuration

```typescript
import { createPostgresBackend } from "syncguard/postgres";
import postgres from "postgres";

const sql = postgres("postgresql://localhost:5432/myapp");
const backend = await createPostgresBackend(sql, {
  tableName: "app_locks", // Default: "syncguard_locks"
  fenceTableName: "app_fence_counters", // Default: "syncguard_fence_counters"
  cleanupInIsLocked: false, // Default: false
  autoCreateTables: true, // Default: true
});
```

**CRITICAL**: Lock table and fence counter table MUST have different names. Configuration validation throws `LockError("InvalidArgument")` if they match.

## Performance Characteristics

- **Latency**: Sub-millisecond for local PostgreSQL, <10ms for remote
- **Throughput**: 500-2000 ops/sec depending on hardware and connection pooling
- **Transaction overhead**: ~2-5ms per operation

## Common Patterns

### Connection Pooling

Use postgres.js connection pooling for optimal performance:

```typescript
const sql = postgres("postgresql://localhost:5432/myapp", {
  max: 10, // Maximum pool size
  idle_timeout: 20, // Idle connection timeout
  connect_timeout: 10, // Connection timeout
});
```

### Index Monitoring

```sql
-- Check if required indexes exist
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'syncguard_locks';

-- Monitor index usage
SELECT schemaname, tablename, indexname, idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
WHERE tablename = 'syncguard_locks';
```

### Cleanup Operations

```sql
-- Count expired locks
SELECT COUNT(*) FROM syncguard_locks
WHERE expires_at_ms < EXTRACT(EPOCH FROM NOW()) * 1000;

-- Manual cleanup (optional, if not using cleanupInIsLocked)
DELETE FROM syncguard_locks
WHERE expires_at_ms < EXTRACT(EPOCH FROM NOW()) * 1000;
```

**WARNING**: NEVER delete from `syncguard_fence_counters` - fence counters must persist indefinitely for fencing safety.

## Implementation References

- **Specification**: See `specs/postgres-backend.md` for complete implementation requirements
- **Common Interface**: See `specs/interface.md` for shared LockBackend contract
- **ADRs**: See `specs/adrs.md` for architectural decisions
