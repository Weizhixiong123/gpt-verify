const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = require('../lib/config');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-routing-test-'));
config.dbFile = path.join(tempDir, 'app.db');
config.adminToken = 'routing-test-only';
config.fivesim.mock = true;
config.routing.mode = 'success';
config.routing.minStock = 50;
config.routing.excludeCountries = [];
config.routing.countryOrderUrl = 'https://example.test/ranking';
const { db, q } = require('../lib/db');
const recommendations = require('../lib/recommendations');
const five = require('../lib/fivesim');
const routes = require('../lib/routes');
const { server } = require('../server');

test('admin routing switch is authenticated, persistent, and reversible', async (t) => {
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const file = config.dbFile + suffix;
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(tempDir);
  });
  const price = (rate24) => ({ cost: 0.1, count: 100, rate24 });
  five.guestPrices = async () => ({ openai: {
    nigeria: { first: price(0) },
    mexico: { first: price(90) },
  } });
  let websiteFailed = false;
  let websiteCalls = 0;
  recommendations.fetchOrder = async () => {
    websiteCalls++;
    if (websiteFailed) throw new Error('推荐网站暂时不可用');
    return ['nigeria'];
  };
  await routes.refresh();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}${config.basePath}/api/admin/`;
  const request = (endpoint, mode, auth = true) => fetch(base + endpoint, {
    method: mode === undefined ? 'GET' : 'POST',
    headers: { ...(auth ? { 'x-admin-token': config.adminToken } : {}), 'Content-Type': 'application/json' },
    body: mode === undefined ? undefined : JSON.stringify({ mode }),
  });

  await t.test('defaults to original routing and rejects unauthenticated or invalid updates', async () => {
    assert.equal(routes.getMode(), 'success');
    assert.equal(routes.candidates(1, new Set())[0].country, 'mexico');
    assert.equal(websiteCalls, 0);
    assert.equal((await request('settings/routing', 'recommended', false)).status, 401);
    assert.equal((await request('settings/routing', 'unknown')).status, 400);
    assert.equal(routes.getMode(), 'success');
  });

  await t.test('saving website mode changes both purchase candidates and display', async () => {
    const res = await request('settings/routing', 'recommended');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).mode, 'recommended');
    assert.equal(q.getSetting.get('routing_mode').value, 'recommended');
    assert.deepEqual(routes.candidates(1, new Set()).map((r) => r.country), ['nigeria']);
    assert.equal(routes.publicTop().mode, 'recommended');
    const overview = await (await request('overview')).json();
    assert.equal(overview.routing.mode, 'recommended');
  });

  await t.test('new process loads the saved choice instead of the environment default', () => {
    const child = spawnSync(process.execPath, ['-e',
      "const c=require('./lib/config');c.dbFile=process.argv[1];c.routing.mode='success';console.log(require('./lib/routes').getMode());",
      config.dbFile], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), 'recommended');
  });

  await t.test('switching back restores original candidates even during website failure', async () => {
    websiteFailed = true;
    const before = websiteCalls;
    const res = await request('settings/routing', 'success');
    assert.equal(res.status, 200);
    assert.equal(routes.candidates(1, new Set())[0].country, 'mexico');
    assert.equal(websiteCalls, before);
    assert.equal(routes.publicTop().mode, 'success');
    await routes.refresh();
    assert.equal(routes.snapshot().lastError, null);
    assert.equal(websiteCalls, before);
  });

  await t.test('failed website switch keeps the saved original mode and candidates', async () => {
    const res = await request('settings/routing', 'recommended');
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'ROUTING_SWITCH_FAILED');
    assert.equal(routes.getMode(), 'success');
    assert.equal(q.getSetting.get('routing_mode').value, 'success');
    assert.equal(routes.candidates(1, new Set())[0].country, 'mexico');
  });
});
