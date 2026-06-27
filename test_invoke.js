import { capabilityRegistry } from './server/protocols/capabilityRegistry.js';
import { pendragonPlaid } from './packages/pendragon-tools-plaid/dist/index.js';

// Setup fake config for pendragonPlaid
pendragonPlaid.registerFromEnv({ register: () => {} }, capabilityRegistry);

console.log('Manifest:', capabilityRegistry.getManifest().map(c => c.name));
