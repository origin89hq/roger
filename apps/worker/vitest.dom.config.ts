import { defineConfig } from "vitest/config";

// The inbox page's own scripts, in a simulated browser. The Worker tests run
// in workerd through vitest.config.ts.
export default defineConfig({
  test: {
    include: ["test-dom/**/*.test.ts"],
    environment: "happy-dom",
  },
});
