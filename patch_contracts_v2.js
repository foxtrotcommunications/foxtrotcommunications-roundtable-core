const fs = require('fs');
const { execSync } = require('child_process');

const contracts = JSON.parse(fs.readFileSync('demo/config/contracts.json', 'utf8'));

const podsRaw = execSync('kubectl get deploy -n rt-pendragon-demo -o json').toString();
const deployments = JSON.parse(podsRaw).items;

for (const dep of deployments) {
  const wsIdContainer = dep.spec.template.spec.containers[0].env.find(e => e.name === 'WS_ID');
  if (!wsIdContainer) continue;
  const wsId = wsIdContainer.value;
  
  const formattedContracts = [];
  
  for (const c of contracts) {
    if (c.source.wsId === wsId) {
      formattedContracts.push({
        contractId: c.contractId,
        type: c.type,
        direction: 'outbound',
        counterparty: { wsId: c.target.wsId, name: c.target.name },
        allowedActions: c.allowedActions,
        status: c.status
      });
    } else if (c.target.wsId === wsId) {
      formattedContracts.push({
        contractId: c.contractId,
        type: c.type,
        direction: 'inbound',
        counterparty: { wsId: c.source.wsId, name: c.source.name },
        allowedActions: c.allowedActions,
        status: c.status
      });
    }
  }
  
  if (formattedContracts.length > 0) {
    const patch = `[{"op": "replace", "path": "/spec/template/spec/containers/0/env", "value": ${JSON.stringify(dep.spec.template.spec.containers[0].env.map(e => e.name === 'RT_CONTRACTS' ? {name: 'RT_CONTRACTS', value: JSON.stringify(formattedContracts)} : e))}}]`;
    
    console.log(`Patching ${dep.metadata.name}...`);
    execSync(`kubectl patch deploy ${dep.metadata.name} -n rt-pendragon-demo --type='json' -p='${patch}'`);
  }
}
console.log("Done");
