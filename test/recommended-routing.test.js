const assert = require('node:assert/strict');
const { test } = require('node:test');
const config = require('../lib/config');

config.dbFile = ':memory:';
config.fivesim.mock = true;
config.routing.countryOrderUrl = 'https://example.test/recommendations';
config.routing.mode = 'recommended';
config.routing.priceCap = 0.35;
config.routing.priceCapRetry = 0.5;
config.routing.minStock = 50;
config.routing.excludeCountries = [];
const five = require('../lib/fivesim');
const recommendations = require('../lib/recommendations');
const routes = require('../lib/routes');
const service = require('../lib/service');
const keys = (list) => list.map((r) => routes.key(r.country, r.operator));

test('website country order controls purchases and display', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let rows = [{ countryIso2: 'NG' }, { countryIso2: 'BD' }, { countryIso2: 'PL' }, { countryIso2: 'NG' }];
  global.fetch = async () => ({ ok: true, json: async () => ({ rows }) });
  const price = (cost, rate24, count = 100) => ({ cost, rate24, count });
  five.guestPrices = async () => ({ openai: {
    nigeria: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`op${i}`, price(0.1, 0)])),
    bangladesh: { missingStats: { cost: 0.1, count: 100 } },
    poland: { first: price(0.2949, 90), expensive: price(0.4, 99), lowStock: price(0.1, 99, 49) },
    mexico: { first: price(0.1, 100) },
  } });

  await t.test('parser preserves order and removes duplicate countries', async () => {
    assert.deepEqual(await recommendations.fetchOrder(config.routing.countryOrderUrl), ['nigeria', 'bangladesh', 'poland']);
  });
  await routes.refresh();

  await t.test('zero/missing scores precede higher scores when the website puts their country first', () => {
    const list = routes.candidates(1, new Set());
    assert.equal(list.length, 11);
    assert.equal(list[0].country, 'nigeria');
    assert.equal(list[9].country, 'bangladesh');
    assert.equal(list[9].score, 0);
    assert.equal(list[10].operator, 'first');
    assert.deepEqual(routes.publicTop().list.map((r) => r.name), ['尼日利亚', '孟加拉国', '波兰']);
    assert.equal(routes.snapshot().routes[0].country, 'nigeria');
    assert.equal(routes.candidates(3, new Set()).find((r) => r.country === 'poland').operator, 'expensive');
  });

  await t.test('rejections prefer other countries and never reuse the rejected operator', () => {
    const list = routes.candidates(1, new Set(), new Set(['nigeria']), new Set(['nigeria:op0']));
    assert.equal(list[0].country, 'bangladesh');
    assert.equal(list[1].country, 'poland');
    assert.equal(list[2].country, 'nigeria');
    assert.ok(!keys(list).includes('nigeria:op0'));
  });

  await t.test('purchases advance past unavailable countries and more than eight operators', async () => {
    const attempts = [];
    five.buy = async (country, operator) => {
      attempts.push(`${country}:${operator}`);
      if (country !== 'poland') throw new five.FiveSimError('no free phones', 200);
      return { id: 1, phone: '+48123456789', country, operator, price: 0.2949,
        expires: new Date(Date.now() + 900000).toISOString() };
    };
    const [code] = service.createCdks(1, 'recommended-test');
    const state = await service.redeem(code);
    assert.equal(attempts.length, 11);
    assert.equal(attempts[0], 'nigeria:op0');
    assert.equal(attempts.at(-1), 'poland:first');
    assert.equal(state.order.phone, '+48123456789');
  });

  await t.test('refresh follows changed website order; invalid refresh keeps the last valid snapshot', async () => {
    rows = [{ countryIso2: 'PL' }, { countryIso2: 'NG' }];
    await routes.refresh();
    assert.equal(routes.candidates(1, new Set())[0].country, 'poland');
    const before = keys(routes.candidates(1, new Set()));
    rows = [];
    await routes.refresh();
    assert.deepEqual(keys(routes.candidates(1, new Set())), before);
    assert.match(routes.snapshot().lastError, /推荐国家/);
  });

  await t.test('HTTP failures reject the recommendation refresh', async () => {
    global.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(recommendations.fetchOrder(config.routing.countryOrderUrl), /HTTP 503/);
  });
});
