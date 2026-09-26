// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'docs/*', '.expo/*', 'coverage/*', 'artifacts/*', 'supabase/functions/*'],
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
    files: ['tests/**', 'scripts/**', '**/__tests__/**', 'jest.config.js'],
    rules: { 'no-restricted-imports': 'off' },
  },
]);
