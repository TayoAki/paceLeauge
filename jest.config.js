/**
 * Two Jest projects:
 *  - unit: domain logic, local journal, recorder/sync services and components (jest-expo iOS preset).
 *  - db:   backend and API integration tests against a real PostgreSQL built by the production
 *          migrator (run through `npm run test:db`, which provisions the database first).
 */
const transformIgnorePatterns = [
  '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|react-navigation|@react-navigation|lucide-react-native|standard-navigation))',
  '/node_modules/react-native-reanimated/plugin/',
  '/node_modules/@react-native/babel-preset/',
];

module.exports = {
  testTimeout: 60000,
  projects: [
    {
      displayName: 'unit',
      preset: 'jest-expo/ios',
      testMatch: ['<rootDir>/src/**/__tests__/**/*.test.[jt]s?(x)', '<rootDir>/tests/unit/**/*.test.[jt]s?(x)'],
      transformIgnorePatterns,
      setupFiles: ['<rootDir>/tests/setup/unit-setup.ts'],
    },
    {
      displayName: 'db',
      preset: 'jest-expo/node',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/backend/**/*.test.ts', '<rootDir>/tests/server/**/*.test.ts'],
      transformIgnorePatterns,
    },
  ],
};
