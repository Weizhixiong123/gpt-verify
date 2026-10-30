// 线路（国家 + 运营商）排序：5SIM 实时成功率 + 本站实际成功率 + 用户已试次数
const config = require('./config');
const { q } = require('./db');
const fivesim = require('./fivesim');
const { countryName } = require('./countries');

const R = config.routing;
let routes = []; // [{ country, operator, cost, count, rate1, rate24, rate168, rate720, s5 }]
let updatedAt = 0;
let lastError = null;

// 5SIM 的分时成功率加权：最近 1 小时、24 小时为主（反映线路现在的状态），7 天、30 天兜底
function fivesimScore(v) {
  const parts = [
    [v.rate1, 0.25],
    [v.rate24, 0.4],
    [v.rate168, 0.2],
    [v.rate720, 0.15],
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
// 这一次没收到码的结果（被拒也算：买家需要再换一次号）。平台回收、用户注销不是线路的问题，不计
const FAIL = new Set(['canceled', 'banned', 'timeout']);
// 熔断只看"收不到码"：被拒通常只是某个号码被标记，不代表线路坏了
const NO_CODE = new Set(['canceled', 'timeout']);

// 本站最近 7 天每条线路的实际结果，以及熔断
function ownStats() {
  const now = Date.now();
  const rows = q.recentOutcomes.all(now - 7 * 86400e3); // 按时间倒序
  const stats = new Map();
  for (const o of rows) {
    if (!SUCCESS.has(o.status) && !FAIL.has(o.status)) continue;
    const k = key(o.country, o.operator);
    const s = stats.get(k) || { n: 0, ok: 0, streak: [], streakDone: false, pausedUntil: 0 };
    s.n++;
    if (SUCCESS.has(o.status)) s.ok++;
    // 熔断用：从最新往前数连续"收不到码"的单，遇到成功就停；被拒的单跳过
    if (!s.streakDone && o.status !== 'banned') {
      if (NO_CODE.has(o.status) && now - o.updated_at < 3600e3) s.streak.push(o);
      else s.streakDone = true;
    }
    stats.set(k, s);
  }
  // 熔断：1 小时内连续 N 单收不到码，且来自至少 2 个不同的 CDK（单个买家运气差不连累所有人）
  for (const s of stats.values()) {
    const r = s.streak.slice(0, R.breakerFails);
    if (r.length === R.breakerFails && new Set(r.map((o) => o.cdk)).size >= 2) {
      s.pausedUntil = r[0].updated_at + R.breakerPauseMin * 60e3;
    }
  }
  return stats;
}

// 每条线路"这一次能收到码"的估计概率（百分比）
function scored() {
  const stats = ownStats();
  const now = Date.now();
  return routes.map((r) => {
    const s = stats.get(key(r.country, r.operator));
    // 本站真实数据最准：样本越多权重越大，15 单起占 80%；用 (成功+1)/(总数+2) 平滑小样本
    const own = s ? ((s.ok + 1) / (s.n + 2)) * 100 : null;
    const w = s ? Math.min(s.n / 15, 0.8) * (s.n >= 3 ? 1 : 0.5) : 0;
    const score = own == null ? r.s5 : r.s5 * (1 - w) + own * w;
    return { ...r, ownN: s?.n || 0, ownOk: s?.ok || 0, score, paused: (s?.pausedUntil || 0) > now ? s.pausedUntil : 0 };
  });
}

// 按"这一次收到码的概率"排序；成功率相差不到 similarRatePts 个百分点的，选便宜的
function rankBySuccess(list) {
  const left = [...list].sort((a, b) => b.score - a.score || a.cost - b.cost);
  const out = [];
  while (left.length) {
    const best = left[0].score;
    const group = left.filter((r) => r.score >= best - R.similarRatePts);
    const pick = group.reduce((m, r) => (r.cost < m.cost || (r.cost === m.cost && r.score > m.score) ? r : m));
    out.push(pick);
    left.splice(left.indexOf(pick), 1);
  }
  return out;
}

// 第 attempt 次取号（从 1 开始）的候选线路，按收到码的概率从高到低
// excludeKeys：这个 CDK 不再用的线路（国家:运营商）
// excludeCountries：这个 CDK 被拒过的国家，优先避开。
// rejectedKeys：这个 CDK 被拒过的线路，绝不回退使用。
function candidates(attempt, excludeKeys, excludeCountries = new Set(), rejectedKeys = new Set()) {
  const cap = attempt > R.escalateAfter ? R.priceCapRetry : R.priceCap;
  const all = rankBySuccess(scored().filter((r) => !r.paused && r.cost <= cap && !rejectedKeys.has(key(r.country, r.operator))));
  const untried = all.filter((r) => !excludeKeys.has(key(r.country, r.operator)));
  const fresh = untried.filter((r) => !excludeCountries.has(r.country));
  if (rejectedKeys.size) {
    // 先尝试其他国家；买不到时再尝试被拒国家内其他运营商。
    // 保留没收到码的原有回退，但禁止回到被拒线路。
    const fallback = all.filter((r) => excludeKeys.has(key(r.country, r.operator)));
    const otherCountries = fresh.concat(fallback.filter((r) => !excludeCountries.has(r.country)));
    const sameCountries = untried.filter((r) => excludeCountries.has(r.country))
      .concat(fallback.filter((r) => excludeCountries.has(r.country)));
    // 分别保留候选，避免其他国家无库存时没有机会尝试同国其他运营商。
    return otherCountries.slice(0, 8).concat(sameCountries.slice(0, 8));
  }
  // 依次放宽：先换国家；没有别的国家可选时允许同国其他线路；全都试过了就允许再用一遍
  return (fresh.length ? fresh : untried.length ? untried : all).slice(0, 8);
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
  // 前台按成功率从高到低展示（实际分配时成功率相近的会优先选便宜的）
  list.sort((a, b) => b.rate - a.rate);
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
