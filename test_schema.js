import { getSchemaForDomain } from './packages/pendragon-tools-plaid/dist/db/schemas.js';
const schema = getSchemaForDomain('checking');
if (schema.includes('domain_goals') && schema.includes('goal_snapshots')) {
  console.log('SUCCESS: Goals schema included.');
} else {
  console.log('FAILURE: Goals schema missing!');
}
