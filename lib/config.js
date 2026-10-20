const fs = require('node:fs');
const path = require('node:path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const list = (v, d) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);

module.exports = {
  port: num(env.PORT, 3000),
  host: env.HOST || '127.0.0.1',
  basePath: (env.BASE_PATH ?? '/sms').replace(/\/+$/, ''),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  trustProxy: env.TRUST_PROXY === '1',
  dbFile: env.DB_FILE || path.join(__dirname, '..', 'data', 'app.db'),
  adminToken: env.ADMIN_TOKEN || '',
  supportContact: env.SUPPORT_CONTACT || '请在闲鱼联系卖家',
  // 页面「联系客服」里显示的微信号、QQ 号，留空则不显示
  supportWechat: (env.SUPPORT_WECHAT || '').trim(),
  supportQq: (env.SUPPORT_QQ || '').trim(),
  // 验证成功页的 Plus 充值优惠（立减金额，单位元）；留空或没填微信就不显示
  promoPlusDiscount: (env.PROMO_PLUS_DISCOUNT || '').trim(),

  fivesim: {
    baseUrl: env.FIVESIM_BASE_URL || 'https://5sim.net/v1',
    token: env.FIVESIM_TOKEN || '',
    mock: env.FIVESIM_MOCK === '1',
    mockSmsDelaySec: num(env.MOCK_SMS_DELAY_SEC, 15),
    // 留空 = 按线路的实时成功率模拟
    mockSmsRate: env.MOCK_SMS_RATE ? Number(env.MOCK_SMS_RATE) : null,
  },

  routing: {
    priceCap: num(env.PRICE_CAP, 0.2),
    priceCapRetry: num(env.PRICE_CAP_RETRY, 0.5),
    escalateAfter: num(env.ESCALATE_AFTER, 2),
    excludeCountries: list(env.EXCLUDE_COUNTRIES, []),
    minStock: num(env.MIN_STOCK, 50),
    refreshMin: num(env.ROUTE_REFRESH_MIN, 10),
    breakerFails: num(env.BREAKER_FAILS, 3),
    breakerPauseMin: num(env.BREAKER_PAUSE_MIN, 60),
  },

  maxSwaps: num(env.MAX_SWAPS, 5),
  swapCooldownSec: num(env.SWAP_COOLDOWN_SEC, 120),
  pollIntervalMs: num(env.POLL_INTERVAL_MS, 2000),
};
