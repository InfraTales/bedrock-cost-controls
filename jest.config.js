module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // test/int runs against DynamoDB Local: `npm run test:int`.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/test/int/'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  testTimeout: 120000,
};
