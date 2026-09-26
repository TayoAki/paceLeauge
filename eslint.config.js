// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'docs/*', '.expo/*', 'coverage/*', 'artifacts/*', 'server/dist/*', 'server/node_modules/*'],
  },
  {
    rules: {
      // Privileged backend credentials and server-only clients never belong in the mobile bundle.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'pg', message: 'Direct database access is test/tooling-only; the app talks to the API.' },
          ],
        },
      ],
    },
  },
  {
    // The API service (server/) owns the database connection; so do tests and tooling.
    files: ['server/**', 'tests/**', 'scripts/**', '**/__tests__/**', 'jest.config.js'],
    rules: { 'no-restricted-imports': 'off' },
  },
]);
