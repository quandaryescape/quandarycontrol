// Global test setup
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
// Never let tests open (and migrate) the real db/quandary.db
process.env.QUANDARY_DB_PATH = process.env.QUANDARY_DB_PATH || ':memory:';
const { closeDatabase } = require('../db/database');

// Set test environment
process.env.NODE_ENV = 'test';

// Increase timeout for async operations
jest.setTimeout(10000);

// Global beforeAll hook
beforeAll(() => {
  // Setup global test configurations
  console.log('Starting test suite...');
});

// Global afterAll hook
afterAll(async () => {
  // Clean up database connections
  try {
    await closeDatabase();
    console.log('Database connections closed');
  } catch (error) {
    console.error('Error closing database:', error);
  }
});

// Global beforeEach hook
beforeEach(() => {
  // Reset any global state before each test
  jest.clearAllMocks();
});

// Mock console methods to reduce noise during tests
global.console = {
  ...console,
  // Uncomment to ignore specific console methods in tests
  // log: jest.fn(),
  // error: jest.fn(),
  // warn: jest.fn(),
  // info: jest.fn(),
  // debug: jest.fn(),
};