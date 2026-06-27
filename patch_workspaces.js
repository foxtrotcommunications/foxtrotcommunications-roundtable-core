const fs = require('fs');
const path = './demo/config/workspaces.json';

const data = JSON.parse(fs.readFileSync(path, 'utf8'));

const goalCaps = [
  "goals.create",
  "goals.list",
  "goals.get",
  "goals.update",
  "goals.delete",
  "goals.evaluateProgress",
  "goals.snapshot"
];

for (const ws of data) {
  // Only add goal capabilities to domain workspaces (skip Arthur/orchestrator and Demographics)
  if (ws.role === 'domain' && ws.domainType !== 'demographics') {
    // Add missing capabilities, ensuring no duplicates
    for (const cap of goalCaps) {
      if (!ws.capabilities.includes(cap)) {
        ws.capabilities.push(cap);
      }
    }
  }
}

fs.writeFileSync(path, JSON.stringify(data, null, 2));
console.log("Patched workspaces.json");
