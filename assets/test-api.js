// Test script for simulation API
const http = require('http');

const testCases = [
  {
    name: 'Fast Mode - Tilt',
    body: {
      cell_name: 'site_0001_f3',
      action: 'tilt',
      params: { degrees: 2 },
      time_entry: { filename: '01-12-2025_12-00.json' },
      mode: 'fast'
    }
  }
];

async function runTest(testCase) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(testCase.body);
    const startTime = Date.now();
    
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3000,
      path: '/api/simulate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const elapsed = Date.now() - startTime;
        console.log(`\n=== ${testCase.name} ===`);
        console.log(`Status: ${res.statusCode}`);
        console.log(`Time: ${elapsed}ms`);
        try {
          const json = JSON.parse(body);
          console.log(`Result:`, JSON.stringify(json, null, 2));
          resolve(json);
        } catch (e) {
          console.log(`Raw Response: ${body}`);
          reject(e);
        }
      });
    });
    
    req.on('error', (e) => {
      console.error(`\n=== ${testCase.name} FAILED ===`);
      console.error(`Error: ${e.message}`);
      reject(e);
    });
    
    req.write(data);
    req.end();
  });
}

async function main() {
  console.log('Testing Simulation API on http://127.0.0.1:3000/api/simulate\n');
  
  for (const testCase of testCases) {
    try {
      await runTest(testCase);
    } catch (e) {
      console.error(`Test failed: ${e.message}`);
    }
  }
}

main();
