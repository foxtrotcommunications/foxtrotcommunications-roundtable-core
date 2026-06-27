import { capabilityRegistry } from './server/protocols/capabilityRegistry.js';
import { registerFromEnv } from './packages/pendragon-tools-plaid/dist/index.js';

process.env.DATABASE_URL = 'postgres://fake';
registerFromEnv({ register: () => {} }, capabilityRegistry);

console.log('Has goals.list:', capabilityRegistry.has('goals.list'));
console.log('Has goals.snapshot:', capabilityRegistry.has('goals.snapshot'));
