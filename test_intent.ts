import { buildIntentToken } from './server/protocols/intentTokenCodec.js';
import fetch from 'node-fetch';

async function main() {
  const tokenStr = await buildIntentToken(
    { op: 'discover', scope: 'capabilities' },
    'fake_source',
    'fake_contract',
    'test_secret'
  );

  const res = await fetch('http://localhost:3000/a2a', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Contract-Id': 'fake_contract',
      'X-Contract-Timestamp': Date.now().toString(),
      'X-Contract-Signature': 'fake_signature' // The actual intent is signed in tokenStr
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'intent/execute',
      params: { token: tokenStr },
      id: 1
    })
  });

  const json = await res.json();
  console.log(JSON.stringify(json, null, 2));
}
main().catch(console.error);
