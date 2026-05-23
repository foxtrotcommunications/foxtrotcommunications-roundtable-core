/** @type {import('jest').Config} */
module.exports = {
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/workspace/'],
  testEnvironment: 'node',
  verbose: true,
  globals: {
    localStorage: undefined,
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: 'server/tsconfig.json',
      isolatedModules: true,
    }],
  },
  moduleFileExtensions: ['js', 'ts', 'json'],
};
