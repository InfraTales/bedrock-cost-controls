// Runs the budget store and the gateway against DynamoDB Local. `npm run test:int`.
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test/int'],
  testMatch: ['**/*.int.test.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  testTimeout: 60000,
};
