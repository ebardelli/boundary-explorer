import { defineConfig } from 'vitest/config';

// Use happy-dom instead of jsdom to avoid parse5 ESM/require compatibility
// issues that some jsdom versions surface when running under CommonJS
// consumers. happy-dom provides a lightweight DOM environment suitable for
// unit tests in this repo.
export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: false,
    include: ['test/**/*.test.js'],
    setupFiles: ['test/setupTests.js']
  }
});
