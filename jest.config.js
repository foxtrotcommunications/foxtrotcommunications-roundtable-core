/** @type {import('jest').Config} */
module.exports = {
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/workspace/'],
  testEnvironment: 'node',
  verbose: true,
  globals: {
    localStorage: undefined,
  },
};
