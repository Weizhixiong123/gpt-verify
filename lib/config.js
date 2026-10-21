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
  // 取卡接口密钥（xianyu-auto-reply「API接口」卡券的请求头里带上）；留空则接口关闭
  cardApiKey: env.CARD_API_KEY || '',
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
    priceCap: num(env.PRICE_CAP, 0.35),
    priceCapRetry: num(env.PRICE_CAP_RETRY, 0.5),
    escalateAfter: num(env.ESCALATE_AFTER, 2),
    // 成功率相差不到这么多个百分点，算"差不多"，选便宜的
    similarRatePts: num(env.SIMILAR_RATE_PTS, 5),
    excludeCountries: list(env.EXCLUDE_COUNTRIES, []),
    minStock: num(env.MIN_STOCK, 50),
    refreshMin: num(env.ROUTE_REFRESH_MIN, 5),
    breakerFails: num(env.BREAKER_FAILS, 3),
    breakerPauseMin: num(env.BREAKER_PAUSE_MIN, 15),
  },
  // 号码被拒后换号：number = 只拉黑这个号码，继续用成功率最高的线路（默认）；country = 跳过整个国家
  rejectSkip: env.REJECT_SKIP === 'country' ? 'country' : 'number',

  maxSwaps: num(env.MAX_SWAPS, 5),
  swapCooldownSec: num(env.SWAP_COOLDOWN_SEC, 120),
  pollIntervalMs: num(env.POLL_INTERVAL_MS, 2000),
};
