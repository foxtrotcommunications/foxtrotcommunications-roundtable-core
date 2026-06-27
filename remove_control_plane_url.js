const { execSync } = require('child_process');

const podsRaw = execSync('kubectl get deploy -n rt-pendragon-demo -o json').toString();
const deployments = JSON.parse(podsRaw).items;

for (const dep of deployments) {
  let envs = dep.spec.template.spec.containers[0].env || [];
  
  // Filter out the CONTROL_PLANE_URL I added/modified
  const newEnvs = envs.filter(e => e.name !== 'CONTROL_PLANE_URL');
  
  const patch = `[{"op": "replace", "path": "/spec/template/spec/containers/0/env", "value": ${JSON.stringify(newEnvs)}}]`;
  
  console.log(`Patching ${dep.metadata.name}...`);
  execSync(`kubectl patch deploy ${dep.metadata.name} -n rt-pendragon-demo --type='json' -p='${patch}'`);
}
console.log("Done");
