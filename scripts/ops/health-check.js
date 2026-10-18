// Health check runner for mai-push processes.
// Usage: node scripts/ops/health-check.js [--quiet]
// Returns exit code 0 if all processes are healthy, 1 otherwise.

const http = require('http');

const TARGETS = [
  { name: 'mai-push-api',      host: '127.0.0.1', port: 8080, path: '/api/health' },
  { name: 'mai-push-worker',   host: '127.0.0.1', port: 3002, path: '/api/health' },
];

const TIMEOUT = 5000;
const quiet = process.argv.includes('--quiet');

function check(target) {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: target.host, port: target.port, path: target.path, timeout: TIMEOUT },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          let ok = false;
          try {
            const j = JSON.parse(body);
            ok = j.status === 'ok';
          } catch {}
          resolve({ ...target, ok, statusCode: res.statusCode, body: body.slice(0, 200) });
        });
        res.on('error', (e) => resolve({ ...target, ok: false, error: e.message }));
      }
    );
    req.on('error', (e) => resolve({ ...target, ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ...target, ok: false, error: 'timeout' }); });
  });
}

async function main() {
  const results = await Promise.all(TARGETS.map(check));
  let allOk = true;

  for (const r of results) {
    if (r.ok) {
      if (!quiet) console.log(`[OK] ${r.name} (${r.host}:${r.port})`);
    } else {
      allOk = false;
      console.error(`[FAIL] ${r.name} (${r.host}:${r.port}) — ${r.error || 'status ' + r.statusCode}`);
    }
  }

  if (!quiet) console.log(allOk ? '\nAll processes healthy.' : '\nSome processes unhealthy!');
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error('Health check error:', e.message);
  process.exit(1);
});
