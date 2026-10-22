import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Many tests run real builds, validations and packed CLIs against temp
    // projects. They take 1-4s locally, and the shared CI runners run the
    // suite in parallel at a fraction of that speed, so vitest's 5s default
    // fails tests that are slow, not broken.
    testTimeout: 30_000,
  },
});
