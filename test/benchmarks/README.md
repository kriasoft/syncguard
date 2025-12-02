# Performance Benchmarks

Performance benchmarks for SyncGuard backends measuring latency, throughput, and resource usage.

## Running Benchmarks

Benchmarks are **opt-in** and disabled by default to keep test suites fast.

```bash
# Run all benchmarks
RUN_BENCHMARKS=1 bun test test/benchmarks/

# Run specific benchmark suite
RUN_BENCHMARKS=1 bun test test/benchmarks/latency.bench.test.ts
RUN_BENCHMARKS=1 bun test test/benchmarks/throughput.bench.test.ts
RUN_BENCHMARKS=1 bun test test/benchmarks/memory.bench.test.ts
```

## Benchmark Suites

### `latency.bench.test.ts`

Measures single operation latency for lock acquire/release operations:

- Average latency (target: <50ms local, <100ms CI)
- P95 latency (target: <100ms local, <200ms CI)
- Script caching performance impact

### `throughput.bench.test.ts`

Measures concurrent load handling:

- Operations per second under concurrent load
- Multi-worker contention scenarios
- Error recovery performance

### `memory.bench.test.ts`

Measures resource usage patterns:

- Large numbers of concurrent locks
- Memory efficiency under load
- Automatic cleanup of expired locks

## Performance Thresholds

Thresholds are adjusted for CI environments to account for higher variance:

- **Local Development**: Strict thresholds (1x multiplier)
- **CI Environment**: Relaxed thresholds (2x multiplier)

The `CI_MULTIPLIER` constant automatically adjusts expectations based on the `CI` environment variable.

## Prerequisites

Benchmarks require running backend services:

- **Redis**: localhost:6379 (or `REDIS_URL` env var)
- **PostgreSQL**: localhost:5432 (or `DATABASE_URL` env var)
- **Firestore**: localhost:8080 (emulator)

## Interpreting Results

Benchmark results are printed to console with:

- Average and P95 latency values
- Throughput in operations per second
- Resource counts and timing breakdowns

Performance expectations may vary based on:

- Hardware specifications
- Network latency
- Backend service load
- CI runner characteristics
