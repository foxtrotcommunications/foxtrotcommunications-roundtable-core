const { registerFromEnv, pendragonPlaid } = require('@pendragon/tools-plaid');

console.log('Checking domain caps:', pendragonPlaid.getCapabilities('checking'));
