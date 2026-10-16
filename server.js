const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./lib/config');
const { q, transaction } = require('./lib/db');
const fivesim = require('./lib/fivesim');
const routes = require('./lib/routes');
const { countryName } = require('./lib/countries');
const service = require('./lib/service');
const { ApiError } = service;

const BASE = config.basePath;

// 页面读一次缓存，把 __BASE__ 替换成挂载路径
const pages = {};
for (const name of ['sms', 'admin']) {
  pages[name] = fs.readFileSync(path.join(__dirname, 'public', `${name}.html`), 'utf8').replaceAll('__BASE__', BASE);
}
const assets = {
  '/theme.css': { type: 'text/css; charset=utf-8', body: fs.readFileSync(path.join(__dirname, 'public', 'theme.css')) },
  '/logo.svg': { type: 'image/svg+xml', body: fs.readFileSync(path.join(__dirname, 'public', 'logo.svg')) },
};

// ---- 工具 ----
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(html);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw new ApiError('请求过大', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError('请求格式错误', 400);
  }
}

function clientIp(req) {
  if (config.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
    if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']);
  }
  return req.socket.remoteAddress || '';
}

// 输错 CDK 太多次的 IP 暂时封禁，防止撞库
const failures = new Map();
const FAIL_LIMIT = 20;
const FAIL_WINDOW = 10 * 60e3;
function checkBlocked(ip) {
  const f = failures.get(ip);
  if (f && f.until > Date.now() && f.count >= FAIL_LIMIT) {
    throw new ApiError('尝试次数过多，请 10 分钟后再试', 429, 'RATE_LIMITED');
  }
}
function recordFailure(ip) {
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || f.until < now) failures.set(ip, { count: 1, until: now + FAIL_WINDOW });
  else f.count++;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, f] of failures) if (f.until < now) failures.delete(ip);
}, 60e3).unref();

function requireAdmin(req) {
  const given = Buffer.from(String(req.headers['x-admin-token'] || ''));
  const want = Buffer.from(config.adminToken);
  if (!config.adminToken || given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    throw new ApiError('管理密码错误', 401, 'UNAUTHORIZED');
  }
}

// ---- 用户接口 ----
async function withCdk(req, res, fn) {
  const ip = clientIp(req);
  checkBlocked(ip);
  try {
    sendJson(res, 200, await fn());
  } catch (err) {
    if (err.code === 'NOT_FOUND') recordFailure(ip);
    throw err;
  }
}

function stream(req, res, url) {
  const code = service.normalizeCdk(url.searchParams.get('cdk'));
  const state = code && service.getState(code);
  if (!state) throw new ApiError('CDK 不存在', 404, 'NOT_FOUND');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 让 nginx 不缓冲，验证码一到立刻推送
  });
  const push = () => res.write(`data: ${JSON.stringify(service.getState(code))}\n\n`);
  push();
  service.bus.on(code, push);
  const ping = setInterval(() => res.write(': ping\n\n'), 20e3);
  req.on('close', () => {
    clearInterval(ping);
    service.bus.off(code, push);
  });
}

// ---- 管理接口 ----
const admin = {
  async 'GET overview'() {
    const counts = Object.fromEntries(q.countByStatus.all().map((r) => [r.status, r.n]));
    let balance = null;
    let balanceError = null;
    try {
      const p = await fivesim.profile();
      balance = p.balance;
    } catch (err) {
      balanceError = err.message;
    }
    const midnight = new Date().setHours(0, 0, 0, 0);
    return {
      counts,
      unexported: q.countUnexported.get().n,
      balance,
      balanceError,
      today: q.orderStatsSince.get(midnight),
      week: q.orderStatsSince.get(Date.now() - 7 * 86400e3),
      mock: config.fivesim.mock,
      routing: config.routing,
      maxSwaps: config.maxSwaps,
      swapCooldownSec: config.swapCooldownSec,
      pollIntervalMs: config.pollIntervalMs,
      supportContact: config.supportContact,
      publicUrl: config.publicUrl,
    };
  },
  async 'GET orders'(req, url) {
    const status = url.searchParams.get('status') || '';
    const search = (url.searchParams.get('q') || '').trim().toUpperCase();
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
    const items = q.listOrders
      .all(status, search ? `%${search}%` : '', limit)
      .map((o) => ({ ...o, country_name: countryName(o.country) }));
    return { items };
  },
  async 'GET routes'() {
    return routes.snapshot();
  },
  async 'POST cdks'(req) {
    const { count, batch } = await readJson(req);
    const n = Math.floor(Number(count));
    if (!(n >= 1 && n <= 1000)) throw new ApiError('数量需在 1–1000 之间');
    return { codes: service.createCdks(n, String(batch || '').slice(0, 50) || null) };
  },
  // 导出未使用的 CDK，并标记为已导出；all=true 时连已导出过的也一起导出
  async 'POST cdks/export'(req) {
    const { all } = await readJson(req);
    const codes = q.unusedCdks.all(all ? 1 : 0).map((r) => r.code);
    const now = Date.now();
    transaction(() => codes.forEach((c) => q.markExported.run(now, c)));
    return { codes };
  },
  async 'GET cdks'(req, url) {
    const status = url.searchParams.get('status') || '';
    const search = (url.searchParams.get('q') || '').trim().toUpperCase();
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 1000);
    const like = search ? `%${search}%` : '';
    return { items: q.listCdks.all(status, like, search, limit) };
  },
  async 'GET cdk'(req, url) {
    const code = service.normalizeCdk(url.searchParams.get('code'));
    const cdk = code && q.getCdk.get(code);
    if (!cdk) throw new ApiError('CDK 不存在', 404);
    const orders = q.ordersByCdk.all(code).map((o) => ({ ...o, country_name: countryName(o.country) }));
    return { cdk, orders, state: service.getState(code) };
  },
  async 'POST cdk/extra'(req) {
    const { code, add } = await readJson(req);
    const c = service.normalizeCdk(code);
    if (!c || !q.getCdk.get(c)) throw new ApiError('CDK 不存在', 404);
    q.addExtraSwaps.run(Math.trunc(Number(add) || 0), c);
    service.bus.emit(c);
    return { ok: true };
  },
  async 'POST cdk/status'(req) {
    const { code, status } = await readJson(req);
    const c = service.normalizeCdk(code);
    const cdk = c && q.getCdk.get(c);
    if (!cdk) throw new ApiError('CDK 不存在', 404);
    if (status === 'disabled') q.setCdkStatus.run('disabled', c);
    else if (status === 'enabled') q.setCdkStatus.run(cdk.used_at ? 'used' : cdk.activated_at ? 'active' : 'unused', c);
    else throw new ApiError('状态无效');
    service.bus.emit(c);
    return { ok: true };
  },
};

// ---- 路由 ----
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (BASE && p !== BASE && !p.startsWith(BASE + '/')) return sendJson(res, 404, { error: 'Not found' });
  const route = p.slice(BASE.length) || '/';

  if (req.method === 'GET' && (route === '/' || route === '')) return sendHtml(res, pages.sms);
  if (req.method === 'GET' && route === '/admin') return sendHtml(res, pages.admin);
  if (req.method === 'GET' && assets[route]) {
    res.writeHead(200, { 'Content-Type': assets[route].type, 'Cache-Control': 'public, max-age=3600' });
    return res.end(assets[route].body);
  }

  if (req.method === 'POST' && route === '/api/redeem') {
    const { cdk } = await readJson(req);
    return withCdk(req, res, () => service.redeem(cdk));
  }
  if (req.method === 'POST' && route === '/api/number') {
    const { cdk } = await readJson(req);
    return withCdk(req, res, () => service.newNumber(cdk));
  }
  if (req.method === 'POST' && route === '/api/swap') {
    const { cdk, reason } = await readJson(req);
    return withCdk(req, res, () => service.swap(cdk, reason === 'rejected' ? 'rejected' : 'nocode'));
  }
  if (req.method === 'GET' && route === '/api/routes') {
    return sendJson(res, 200, routes.publicTop());
  }
  if (req.method === 'GET' && route === '/api/stream') {
    checkBlocked(clientIp(req));
    return stream(req, res, url);
  }

  if (route.startsWith('/api/admin/')) {
    const fn = admin[`${req.method} ${route.slice('/api/admin/'.length)}`];
    if (fn) {
      requireAdmin(req);
      return sendJson(res, 200, await fn(req, url));
    }
  }

  sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!(err instanceof ApiError)) console.error(err);
    if (res.headersSent) return res.end();
    sendJson(res, err.status || 500, { error: err instanceof ApiError ? err.message : '服务器错误，请稍后再试', code: err.code });
  });
});

server.listen(config.port, config.host, () => {
  console.log(`gpt-verify listening on http://${config.host}:${config.port}${BASE || '/'}`);
  if (config.fivesim.mock) console.log('FIVESIM_MOCK=1：使用模拟 5SIM，不会真实买号');
  else if (!config.fivesim.token) console.warn('警告：未设置 FIVESIM_TOKEN');
  if (!config.adminToken) console.warn('警告：未设置 ADMIN_TOKEN，管理后台不可用');
  service.startPoller();
});
