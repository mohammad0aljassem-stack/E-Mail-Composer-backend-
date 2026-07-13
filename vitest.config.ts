import { defineConfig } from "vitest/config";

// Two projects:
//   unit        — pure, in-memory, no network, no Postgres. Coverage gates here.
//   integration — fake IMAP/SMTP protocol servers + a local pg-boss/Postgres.
//                 Requires TEST_DATABASE_URL (see scripts/test-db.sh).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
          globals: false,
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          environment: "node",
          globals: false,
          // Integration tests share a single Postgres/pg-boss instance; run
          // them serially to keep queue + claim state deterministic.
          fileParallelism: false,
          hookTimeout: 30_000,
          testTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/entrypoints/**",
        "src/**/index.ts",
        "src/**/*.d.ts",
        // Real network/DB adapters + wiring: exercised by the integration
        // suite (test/integration, requires local Postgres + fakes), not by the
        // unit-coverage gate. Kept out of the unit threshold so it measures the
        // pure, deterministic logic honestly.
        "src/providers/imap-smtp/imap-client.ts",
        "src/workers/provider-factory.ts",
        "src/db/pool.ts",
        "src/db/repositories.ts",
        "src/queues/queue-manager.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
