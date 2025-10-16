-- SPDX-FileCopyrightText: 2025-present Kriasoft
-- SPDX-License-Identifier: MIT
--
-- ============================================================================
-- Lock Table: Primary storage for active locks
-- ============================================================================
CREATE TABLE syncguard_locks (
  -- Primary key: O(1) lookups for acquire/isLocked
  key TEXT PRIMARY KEY,
  -- Lock identifier: 22-char base64url (cryptographically random)
  lock_id TEXT NOT NULL,
  -- Timestamps: Milliseconds since epoch
  expires_at_ms BIGINT NOT NULL,
  acquired_at_ms BIGINT NOT NULL,
  -- Fence token: 15-digit zero-padded string (e.g., "000000000000042")
  fence TEXT NOT NULL,
  -- Original user key: For debugging and sanitization
  user_key TEXT NOT NULL
);

-- ============================================================================
-- Required Indexes
-- ============================================================================
-- Index for reverse lookup by lockId (release/extend/lookup operations)
CREATE UNIQUE INDEX idx_syncguard_locks_lock_id ON syncguard_locks (lock_id);

-- Index for cleanup queries and operational monitoring
-- Enables efficient: SELECT * FROM locks WHERE expires_at_ms < NOW()
CREATE INDEX idx_syncguard_locks_expires ON syncguard_locks (expires_at_ms);

-- ============================================================================
-- Fence Counter Table: Monotonic counters (NEVER deleted)
-- ============================================================================
-- CRITICAL: Counter records are initialized by application code using two-step
-- pattern to prevent absent-row race conditions. See postgres-backend.md for
-- canonical pattern. Schema DEFAULT 0 is defensive; actual initialization
-- happens via INSERT ... ON CONFLICT DO NOTHING in acquire operation.
CREATE TABLE syncguard_fence_counters (
  -- Primary key: Derived via two-step pattern (see ADR-006)
  fence_key TEXT PRIMARY KEY,
  -- Monotonic counter: Starts at 0, incremented on each acquire
  fence BIGINT NOT NULL DEFAULT 0,
  -- Original key for debugging (optional)
  key_debug TEXT
);

-- ============================================================================
-- Optional: Human-Readable Timestamps (for debugging/monitoring)
-- ============================================================================
-- These are truly optional and can be added without code changes
-- Useful for manual queries: SELECT * FROM locks WHERE expires_at_ts < NOW()
ALTER TABLE syncguard_locks
ADD COLUMN IF NOT EXISTS expires_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (to_timestamp(expires_at_ms / 1000.0)) STORED,
ADD COLUMN IF NOT EXISTS acquired_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (to_timestamp(acquired_at_ms / 1000.0)) STORED;
