const { execSync } = require('child_process');

const podsRaw = execSync('kubectl get deploy -n rt-pendragon-demo -o json').toString();
const deployments = JSON.parse(podsRaw).items;

for (const dep of deployments) {
  const patch = `[{"op": "replace", "path": "/spec/template/spec/containers/0/env", "value": ${JSON.stringify(
    dep.spec.template.spec.containers[0].env.map(e => 
      e.name === 'CONTROL_PLANE_URL' ? {name: 'CONTROL_PLANE_URL', value: 'http://127.0.0.1:9999'} : e
    )
  )}}]`;
  
  console.log(`Patching ${dep.metadata.name}...`);
  execSync(`kubectl patch deploy ${dep.metadata.name} -n rt-pendragon-demo --type='json' -p='${patch}'`);
}
console.log("Done");
