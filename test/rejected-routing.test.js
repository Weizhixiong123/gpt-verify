const assert = require('node:assert/strict');
const { test } = require('node:test');
const config = require('../lib/config');

// Keep tests isolated from local databases and all real provider requests.
config.dbFile = ':memory:';
config.fivesim.mock = true;
config.routing.priceCap = 1;
config.routing.priceCapRetry = 1;
config.routing.minStock = 1;
config.routing.excludeCountries = [];
config.routing.similarRatePts = 0;
config.routing.countryOrderUrl = '';
config.routing.mode = 'success';
const five = require('../lib/fivesim');
const routes = require('../lib/routes');
const { q } = require('../lib/db');
const service = require('../lib/service');
const keys = (items) => items.map((r) => routes.key(r.country, r.operator));
const price = (rate) => ({ cost: 0.1, count: 100, rate24: rate });

test('rejected routes are excluded per CDK with country-first alternatives', async (t) => {
  five.guestPrices = async () => ({ openai: {
    usa: { first: price(99), second: price(95) },
    poland: { first: price(80) },
  } });
  await routes.refresh();

  await t.test('other countries precede same-country operators', () => {
    assert.deepEqual(keys(routes.candidates(1, new Set(), new Set(['usa']), new Set(['usa:first']))),
      ['poland:first', 'usa:second']);
  });

  await t.test('strict exclusions survive the no-code fallback', () => {
    assert.deepEqual(keys(routes.candidates(1, new Set(['poland:first', 'usa:second']),
      new Set(['usa']), new Set(['usa:first']))), ['poland:first', 'usa:second']);
    assert.deepEqual(routes.candidates(1, new Set(), new Set(['usa', 'poland']),
      new Set(['usa:first', 'usa:second', 'poland:first'])), []);
  });

  await t.test('no-code behavior and other CDKs keep original candidates', () => {
    const original = keys(routes.candidates(1, new Set()));
    assert.deepEqual(original, ['usa:first', 'usa:second', 'poland:first']);
    assert.deepEqual(keys(routes.candidates(1, new Set(original))), original);
  });

  let seq = 0;
  let failPoland = false;
  const attempts = [];
  const banned = [];
  five.buy = async (country, operator) => {
    attempts.push(`${country}:${operator}`);
    if (failPoland && country === 'poland') throw new five.FiveSimError('no free phones', 200);
    return { id: ++seq, phone: '+15551234567', country, operator, price: 0.1,
      expires: new Date(Date.now() + 900000).toISOString() };
  };
  five.ban = async (id) => { banned.push(id); return {}; };

  await t.test('immediate rejected swap falls back to another operator when other country has no stock', async () => {
    const [code] = service.createCdks(1, 'test');
    await service.redeem(code);
    failPoland = true;
    attempts.length = 0;
    const state = await service.swap(code, 'rejected');
    assert.deepEqual(attempts, ['poland:first', 'usa:second']);
    assert.equal(banned.length, 1);
    assert.equal(state.order.status, 'pending');
    assert.equal(q.ordersByCdk.all(code)[1].status, 'banned');
    failPoland = false;
  });

  await t.test('exhausted alternatives do not buy or consume another attempt', async () => {
    const [code] = service.createCdks(1, 'test');
    await service.redeem(code);
    await service.swap(code, 'rejected');
    await service.swap(code, 'rejected');
    attempts.length = 0;
    await assert.rejects(service.swap(code, 'rejected'), { code: 'NO_ALTERNATIVE_ROUTES' });
    const state = service.getState(code);
    assert.equal(state.order.status, 'banned');
    assert.equal(q.ordersByCdk.all(code).length, 3);
    assert.equal(attempts.length, 0);
    await assert.rejects(service.newNumber(code), { code: 'NO_ALTERNATIVE_ROUTES' });
    assert.equal(service.getState(code).numbersLeft, state.numbersLeft);

    const [otherCode] = service.createCdks(1, 'test');
    await service.redeem(otherCode);
    assert.equal(attempts.at(-1), 'usa:first');
  });
});
