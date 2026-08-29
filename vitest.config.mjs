import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // Without this, spying the same pool method each test reuses one spy and
    // carries its call history forward - "was the DB touched?" assertions then
    // pass or fail depending on what ran before them.
    restoreMocks: true,
    // The server refuses to boot without a secret, by design. Tests get their
    // own so they never depend on (or accidentally use) the real one in .env.
    env: {
      JWT_SECRET: 'test-only-secret-not-used-anywhere-real',
      DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
      DEMO_LOGIN: 'on',
      NODE_ENV: 'test',
    },
  },
});
