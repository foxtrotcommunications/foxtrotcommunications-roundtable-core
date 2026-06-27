const { execSync } = require('child_process');

const podsRaw = execSync('kubectl get deploy -n rt-pendragon-demo -o json').toString();
const deployments = JSON.parse(podsRaw).items;

for (const dep of deployments) {
  let envs = dep.spec.template.spec.containers[0].env || [];
  const cpIndex = envs.findIndex(e => e.name === 'CONTROL_PLANE_URL');
  if (cpIndex !== -1) {
    envs[cpIndex].value = 'http://127.0.0.1:9999';
  } else {
    envs.push({ name: 'CONTROL_PLANE_URL', value: 'http://127.0.0.1:9999' });
  }
  
  const patch = `[{"op": "replace", "path": "/spec/template/spec/containers/0/env", "value": ${JSON.stringify(envs)}}]`;
  
  console.log(`Patching ${dep.metadata.name}...`);
  execSync(`kubectl patch deploy ${dep.metadata.name} -n rt-pendragon-demo --type='json' -p='${patch}'`);
}
console.log("Done");
