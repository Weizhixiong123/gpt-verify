const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const config = require('./config');
const { q, transaction } = require('./db');
const fivesim = require('./fivesim');
const routes = require('./routes');
const { countryName, splitPhone } = require('./countries');

class ApiError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// 状态变化时按 CDK 广播，SSE 连接订阅它把最新状态推给页面
const bus = new EventEmitter();
bus.setMaxListeners(0);
const notify = (code) => bus.emit(code);

// 同一个 CDK 的操作串行执行，防止连点导致重复买号
const locks = new Map();
async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => (release = r));
  const tail = prev.then(() => mine);
  locks.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

// ---- CDK ----
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉了 0/O、1/I 这类易混字符

function generateCode() {
  let s = '';
  for (let i = 0; i < 16; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s.match(/.{4}/g).join('-');
}

function normalizeCdk(input) {
  const raw = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length !== 16) return null;
  return raw.match(/.{4}/g).join('-');
}

function createCdks(count, batch) {
  const now = Date.now();
  const codes = [];
  transaction(() => {
    while (codes.length < count) {
      const code = generateCode();
      try {
        q.insertCdk.run(code, batch || null, now);
        codes.push(code);
      } catch (err) {
        if (!/UNIQUE/.test(err.message)) throw err;
      }
    }
  });
  return codes;
}

function requireCdk(input) {
  const code = normalizeCdk(input);
  const cdk = code && q.getCdk.get(code);
  if (!cdk) throw new ApiError('CDK 不存在，请检查是否输入正确', 404, 'NOT_FOUND');
  if (cdk.status === 'disabled') throw new ApiError(`此 CDK 已停用，${config.supportContact}`, 403, 'DISABLED');
  return cdk;
}

const allowance = (cdk) => 1 + config.maxSwaps + cdk.extra_swaps;
// 被 5SIM 那边取消/回收的号码（released）不是用户造成的，不占用次数
const usedCount = (orders) => orders.filter((o) => o.status !== 'released').length;

// ---- 给前端的状态 ----
function getState(code) {
  const cdk = q.getCdk.get(code);
  if (!cdk) return null;
  const orders = q.ordersByCdk.all(code);
  const cur = orders[0];
  return {
    cdk: code,
    status: cdk.status,
    numbersLeft: Math.max(0, allowance(cdk) - usedCount(orders)),
    // 当前号码是平台回收后自动换来的
    replaced: cur?.status === 'pending' && orders[1]?.status === 'released',
    support: config.supportContact,
    now: Date.now(),
    order: cur
      ? {
          phone: cur.phone,
          ...splitPhone(cur.phone, cur.country),
          country: cur.country,
          countryName: countryName(cur.country),
          successRate: cur.est_rate == null ? null : Math.round(cur.est_rate),
          status: cur.status,
          code: cur.code,
          smsText: cur.sms_text,
          createdAt: cur.created_at,
          expiresAt: cur.expires_at,
          swapAt: cur.created_at + config.swapCooldownSec * 1000,
        }
      : null,
  };
}

// ---- 买号 / 换号 ----
// 按「这是用户第几次取号」+「线路实时成功率」挑线路，依次尝试直到买到
async function buyFromRoutes(attempt, tried) {
  if (!routes.isReady()) await routes.refresh();
  const list = routes.candidates(attempt, tried);
  if (!list.length) throw new Error('没有符合价格上限的线路');
  let lastErr;
  for (const r of list) {
    try {
      const o = await fivesim.buy(r.country, r.operator, { cost: r.cost, successRate: r.score });
      return { o, route: r };
    } catch (err) {
      lastErr = err;
      if (!fivesim.TRY_NEXT.test(err.message)) throw err;
    }
  }
  throw lastErr;
}

async function buyLocked(cdk) {
  const orders = q.ordersByCdk.all(cdk.code);
  const used = usedCount(orders);
  if (used >= allowance(cdk)) {
    throw new ApiError(`换号次数已用完，${config.supportContact}`, 409, 'EXHAUSTED');
  }
  const tried = new Set(orders.map((x) => routes.key(x.country, x.operator)));
  let o, route;
  try {
    ({ o, route } = await buyFromRoutes(used + 1, tried));
  } catch (err) {
    console.error(`[buy] ${cdk.code}: ${err.message}`);
    if (/balance/i.test(err.message)) {
      throw new ApiError(`系统维护中，暂时无法取号，${config.supportContact}`, 503, 'NO_BALANCE');
    }
    throw new ApiError('当前暂无可用号码，请稍后再试', 503, 'NO_NUMBERS');
  }
  const now = Date.now();
  const expiresAt = Date.parse(o.expires) || now + 15 * 60e3;
  transaction(() => {
    q.insertOrder.run(cdk.code, o.id, o.phone, o.country || route.country, o.operator || route.operator, o.price ?? route.cost, route.score, now, expiresAt, now);
    q.activateCdk.run(now, cdk.code);
  });
  console.log(`[buy] ${cdk.code}: #${o.id} ${o.phone} ${route.country}:${route.operator} ${o.price ?? route.cost} (预估 ${route.score.toFixed(1)}%)`);
  notify(cdk.code);
}

// 输入 CDK：第一次用就直接取号；之前用过就返回当前状态（刷新页面时恢复）
async function redeem(input) {
  const cdk = requireCdk(input);
  return withLock(cdk.code, async () => {
    if (cdk.status === 'unused' && q.ordersByCdk.all(cdk.code).length === 0) await buyLocked(cdk);
    return getState(cdk.code);
  });
}

// 旧号码已失效（超时 / 换号时买号失败）后，重新取号
async function newNumber(input) {
  const { code } = requireCdk(input);
  return withLock(code, async () => {
    const cdk = q.getCdk.get(code);
    const cur = q.ordersByCdk.all(code)[0];
    if (cdk.status === 'used' || cur?.status === 'pending') return getState(code);
    await buyLocked(cdk);
    return getState(code);
  });
}

// 换号：reason = 'nocode'（等太久没收到）| 'rejected'（ChatGPT 提示号码不可用）
async function swap(input, reason) {
  const { code } = requireCdk(input);
  return withLock(code, async () => {
    const cdk = q.getCdk.get(code);
    if (cdk.status === 'used') return getState(code);
    const cur = q.ordersByCdk.all(code)[0];

    if (cur?.status === 'pending') {
      const wait = Math.ceil((cur.created_at + config.swapCooldownSec * 1000 - Date.now()) / 1000);
      if (reason !== 'rejected' && wait > 0) {
        throw new ApiError(`请先在 ChatGPT 发送验证码，${wait} 秒后才能换号`, 429, 'COOLDOWN');
      }
      if (usedCount(q.ordersByCdk.all(code)) >= allowance(cdk)) {
        throw new ApiError(`换号次数已用完，${config.supportContact}`, 409, 'EXHAUSTED');
      }
      // 号码被 OpenAI 拒绝的用 ban，5SIM 以后不会再分到这个号；两种都会退款
      const banned = reason === 'rejected';
      try {
        await (banned ? fivesim.ban(cur.fivesim_id) : fivesim.cancel(cur.fivesim_id));
        q.setOrderStatus.run(banned ? 'banned' : 'canceled', Date.now(), cur.id);
      } catch (err) {
        console.error(`[cancel] #${cur.fivesim_id}: ${err.message}`);
        // 请求报错不代表没生效（比如超时但 5SIM 已经取消了），以 5SIM 上的实际状态为准
        let real = null;
        try {
          real = await fivesim.check(cur.fivesim_id);
        } catch {}
        if (/order has sms/i.test(err.message) || real?.sms?.length) {
          // 取消的瞬间验证码到了，直接把码给用户
          await refreshLocked(cur.id);
          return getState(code);
        }
        if (real?.status === 'TIMEOUT' || /order expired/i.test(err.message)) {
          q.setOrderStatus.run('timeout', Date.now(), cur.id);
        } else if (['CANCELED', 'BANNED'].includes(real?.status) || /order not found/i.test(err.message)) {
          q.setOrderStatus.run(banned ? 'banned' : 'canceled', Date.now(), cur.id);
        } else {
          throw new ApiError('取消旧号码失败，请稍后再试', 502, 'CANCEL_FAILED');
        }
      }
      notify(code);
    }

    await buyLocked(cdk);
    return getState(code);
  });
}

// ---- 轮询 5SIM ----
function extractCode(text) {
  const m = String(text || '').match(/\b\d{6}\b/) || String(text || '').match(/\b\d{4,8}\b/);
  return m ? m[0] : null;
}

async function refreshLocked(orderId) {
  const order = q.getOrder.get(orderId);
  if (!order || !['pending', 'received'].includes(order.status)) return;
  const now = Date.now();

  let d;
  try {
    d = await fivesim.check(order.fivesim_id);
  } catch (err) {
    if (order.status === 'received' && (/order not found/i.test(err.message) || now > order.expires_at + 5 * 60e3)) {
      q.setOrderStatus.run('finished', now, order.id);
      notify(order.cdk);
    } else if (/order not found/i.test(err.message)) {
      await releaseLocked(order, '5SIM 找不到订单');
    } else if (now > order.expires_at + 5 * 60e3) {
      q.setOrderStatus.run('timeout', now, order.id);
      notify(order.cdk);
    }
    return;
  }

  const sms = Array.isArray(d.sms) ? d.sms : [];
  const last = sms[sms.length - 1];
  if (last) {
    const code = last.code || extractCode(last.text);
    if (code !== order.code || last.text !== order.sms_text) {
      transaction(() => {
        q.setOrderSms.run(code, last.text || null, now, order.id);
        q.useCdk.run(now, order.cdk);
      });
      console.log(`[sms] ${order.cdk}: #${order.fivesim_id} code=${code}`);
      notify(order.cdk);
    }
  }

  // 我们自己取消/拉黑时会先改掉本地状态，所以这里还是 pending 却被取消，说明是 5SIM 那边回收的
  if (!sms.length && order.status === 'pending' && (d.status === 'CANCELED' || d.status === 'BANNED')) {
    return releaseLocked(order, `5SIM 状态 ${d.status}`);
  }

  let next = null;
  if (d.status === 'TIMEOUT') next = sms.length ? 'finished' : 'timeout';
  else if (d.status === 'FINISHED') next = 'finished';
  else if (now > order.expires_at + 30e3) {
    // 过了有效期 5SIM 还没结束订单：有码就完成，没码就取消（退款）
    try {
      await (sms.length ? fivesim.finish(order.fivesim_id) : fivesim.cancel(order.fivesim_id));
    } catch {}
    next = sms.length ? 'finished' : 'timeout';
  }
  if (next) {
    q.setOrderStatus.run(next, now, order.id);
    notify(order.cdk);
  }
}

// 号码被平台回收：不扣用户次数，自动换一个新号；买不到就让用户稍后点「获取新号码」
// 每个 CDK 最多免费回收几次，防止异常情况下无限自动换号
const MAX_FREE_RELEASES = 2;

async function releaseLocked(order, reason) {
  const released = q.ordersByCdk.all(order.cdk).filter((o) => o.status === 'released').length;
  if (released >= MAX_FREE_RELEASES) {
    // 回收太频繁，多半不是平台问题：按普通取消处理（占次数），也不再自动换号
    q.setOrderStatus.run('canceled', Date.now(), order.id);
    console.warn(`[release] ${order.cdk}: #${order.fivesim_id} ${reason}，已回收 ${released} 次，不再自动换号`);
    notify(order.cdk);
    return;
  }
  q.setOrderStatus.run('released', Date.now(), order.id);
  console.log(`[release] ${order.cdk}: #${order.fivesim_id} ${reason}，自动换号`);
  notify(order.cdk);
  const cdk = q.getCdk.get(order.cdk);
  if (!cdk || cdk.status !== 'active') return;
  try {
    await buyLocked(cdk);
  } catch (err) {
    console.error(`[release] ${order.cdk}: 自动换号失败 ${err.message}`);
  }
}

let polling = false;
async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    const live = q.liveOrders.all();
    await Promise.all(
      live.map((o) =>
        withLock(o.cdk, () => refreshLocked(o.id)).catch((err) => console.error(`[poll] #${o.id}: ${err.message}`))
      )
    );
  } finally {
    polling = false;
  }
}

function startPoller() {
  routes.start();
  const tick = () => pollOnce().finally(() => setTimeout(tick, config.pollIntervalMs));
  tick();
}

module.exports = {
  ApiError,
  bus,
  normalizeCdk,
  createCdks,
  getState,
  redeem,
  newNumber,
  swap,
  startPoller,
};
