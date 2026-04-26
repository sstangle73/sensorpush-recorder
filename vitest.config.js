import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.js'],
    env: { NODE_ENV: 'test' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['server.js', 'db.js', 'sensorpush.js', 'poller.js', 'config.js'],
    },
  },
});
