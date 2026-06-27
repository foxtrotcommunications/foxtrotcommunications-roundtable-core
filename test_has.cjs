const { capabilityRegistry } = require('./server/protocols/capabilityRegistry');
const { registerFromEnv } = require('@pendragon/tools-plaid');

process.env.DATABASE_URL = 'postgres://fake';
registerFromEnv({ register: () => {} }, capabilityRegistry);

console.log('Has goals.list:', capabilityRegistry.has('goals.list'));
console.log('Has goals.snapshot:', capabilityRegistry.has('goals.snapshot'));
