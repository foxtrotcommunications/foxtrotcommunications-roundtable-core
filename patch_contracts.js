const fs = require('fs');
const { execSync } = require('child_process');

const contracts = JSON.parse(fs.readFileSync('demo/config/contracts.json', 'utf8'));

// Get all deployments in the namespace
const podsRaw = execSync('kubectl get deploy -n rt-pendragon-demo -o json').toString();
const deployments = JSON.parse(podsRaw).items;

for (const dep of deployments) {
  const wsIdContainer = dep.spec.template.spec.containers[0].env.find(e => e.name === 'WS_ID');
  if (!wsIdContainer) continue;
  const wsId = wsIdContainer.value;
  
  // Find contracts for this workspace
  const isArthur = wsId === 'FY6M0lU0katTXza3Yo1r';
  const myContracts = contracts.filter(c => 
    isArthur ? c.source.wsId === wsId : c.target.wsId === wsId
  );
  
  if (myContracts.length > 0) {
    const contractsStr = JSON.stringify(myContracts).replace(/"/g, '\\"');
    const patch = `[{"op": "replace", "path": "/spec/template/spec/containers/0/env", "value": ${JSON.stringify(dep.spec.template.spec.containers[0].env.map(e => e.name === 'RT_CONTRACTS' ? {name: 'RT_CONTRACTS', value: JSON.stringify(myContracts)} : e))}}]`;
    
    console.log(`Patching ${dep.metadata.name}...`);
    execSync(`kubectl patch deploy ${dep.metadata.name} -n rt-pendragon-demo --type='json' -p='${patch}'`);
  }
}
console.log("Done");
