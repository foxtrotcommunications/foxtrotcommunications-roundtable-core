const { registerFromEnv } = require('@pendragon/tools-plaid');
const tools = {};
const caps = {};
registerFromEnv({
  register: (name, handler) => { tools[name] = handler; }
}, {
  register: (cap, handler) => { caps[cap.name] = handler || cap.handler; }
});
console.log('Registered Tools:', Object.keys(tools));
console.log('Registered Capabilities:', Object.keys(caps));
