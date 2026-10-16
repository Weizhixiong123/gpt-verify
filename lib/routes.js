// 线路（国家 + 运营商）排序：5SIM 实时成功率 + 本站实际成功率 + 用户已试次数
const config = require('./config');
const { q } = require('./db');
const fivesim = require('./fivesim');
const { countryName } = require('./countries');

const R = config.routing;
let routes = []; // [{ country, operator, cost, count, rate1, rate24, rate168, rate720, s5 }]
let updatedAt = 0;
let lastError = null;

// 5SIM 的分时成功率加权：近 24 小时为主，7 天、30 天兜底，避免短期波动
function fivesimScore(v) {
  const parts = [
    [v.rate24, 0.5],
    [v.rate168, 0.3],
    [v.rate720, 0.2],
  ].filter(([r]) => typeof r === 'number');
  if (!parts.length) return null;
  const w = parts.reduce((s, [, k]) => s + k, 0);
  return parts.reduce((s, [r, k]) => s + r * k, 0) / w;
}

async function refresh() {
  try {
    const data = await fivesim.guestPrices();
    const list = [];
    for (const [country, ops] of Object.entries(data.openai || {})) {
      if (R.excludeCountries.includes(country)) continue;
      for (const [operator, v] of Object.entries(ops)) {
        const s5 = fivesimScore(v);
        if (s5 == null || !(v.count >= R.minStock)) continue;
        list.push({ country, operator, cost: v.cost, count: v.count, rate1: v.rate1, rate24: v.rate24, rate168: v.rate168, rate720: v.rate720, s5 });
      }
    }
    if (!list.length) throw new Error('5SIM 没有返回可用线路');
    routes = list;
    updatedAt = Date.now();
    lastError = null;
  } catch (err) {
    lastError = err.message;
    console.error(`[routes] 刷新失败: ${err.message}`);
  }
}

const key = (country, operator) => `${country}:${operator}`;
const SUCCESS = new Set(['received', 'finished']);
const FAIL = new Set(['canceled', 'banned', 'timeout', 'released']);

// 本站最近 7 天每条线路的实际结果
function ownStats() {
  const now = Date.now();
  const rows = q.recentOutcomes.all(now - 7 * 86400e3);
  const stats = new Map();
  for (const o of rows) {
    if (!SUCCESS.has(o.status) && !FAIL.has(o.status)) continue;
    const k = key(o.country, o.operator);
    const s = stats.get(k) || { n: 0, ok: 0, recent: [], pausedUntil: 0 };
    s.n++;
    if (SUCCESS.has(o.status)) s.ok++;
    if (s.recent.length < R.breakerFails) s.recent.push(o); // rows 按时间倒序
    stats.set(k, s);
  }
  // 熔断：最近 N 单全部失败，且都在 1 小时内 → 暂停到最后一次失败后 1 小时
  for (const s of stats.values()) {
    const r = s.recent;
    if (r.length === R.breakerFails && r.every((o) => FAIL.has(o.status) && now - o.updated_at < 3600e3)) {
      s.pausedUntil = r[0].updated_at + R.breakerPauseMin * 60e3;
    }
  }
  return stats;
}

function scored() {
  const stats = ownStats();
  const now = Date.now();
  return routes.map((r) => {
    const s = stats.get(key(r.country, r.operator));
    // 本站样本越多权重越大，最多 70%；用 (成功+1)/(总数+2) 平滑小样本
    const own = s ? ((s.ok + 1) / (s.n + 2)) * 100 : null;
    const w = s ? Math.min(s.n / 20, 0.7) : 0;
    const score = own == null ? r.s5 : r.s5 * (1 - w) + own * w;
    return { ...r, ownN: s?.n || 0, ownOk: s?.ok || 0, score, paused: (s?.pausedUntil || 0) > now ? s.pausedUntil : 0 };
  });
}

// 第 attempt 次取号（从 1 开始）的候选线路，按成功率从高到低
function candidates(attempt, excludeKeys) {
  const cap = attempt > R.escalateAfter ? R.priceCapRetry : R.priceCap;
  const all = scored()
    .filter((r) => !r.paused && r.cost <= cap)
    .sort((a, b) => b.score - a.score || a.cost - b.cost);
  const fresh = all.filter((r) => !excludeKeys.has(key(r.country, r.operator)));
  // 合适的线路都试过了，就允许再用一遍
  return (fresh.length ? fresh : all).slice(0, 8);
}

// 给前台展示：首次取号会用到的线路，按国家去重，只给中文名和成功率
function publicTop(n = 6) {
  const seen = new Set();
  const list = [];
  for (const r of candidates(1, new Set())) {
    if (seen.has(r.country)) continue;
    seen.add(r.country);
    list.push({ name: countryName(r.country), rate: Math.round(r.score) });
    if (list.length >= n) break;
  }
  return { updatedAt, list };
}

function snapshot() {
  return {
    updatedAt,
    lastError,
    priceCap: R.priceCap,
    priceCapRetry: R.priceCapRetry,
    escalateAfter: R.escalateAfter,
    routes: scored()
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .map((r) => ({ ...r, name: countryName(r.country) })),
  };
}

function start() {
  refresh();
  setInterval(refresh, R.refreshMin * 60e3).unref();
}

module.exports = { start, refresh, candidates, snapshot, publicTop, key, isReady: () => routes.length > 0 };
