// 5SIM API 封装：https://5sim.net/docs
// Node 自带的 fetch 默认复用 keep-alive 连接，重复调用不必重新握手。
const config = require('./config');

const { baseUrl, token } = config.fivesim;
const PRODUCT = 'openai'; // 本系统只接 ChatGPT 验证码

class FiveSimError extends Error {
  constructor(message, httpStatus) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

async function call(path, auth = true) {
  let res;
  try {
    res = await fetch(baseUrl + path, {
      headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new FiveSimError(`network: ${err.message}`, 0);
  }
  const text = (await res.text()).trim();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  // 5SIM 的错误一般是纯文本（如 "no free phones"），且有时 HTTP 状态是 200
  if (!res.ok || !data || typeof data !== 'object') {
    const msg = typeof data === 'string' ? data : text || res.statusText;
    throw new FiveSimError(msg, res.status);
  }
  return data;
}

// 各国家/运营商的价格、库存、分时成功率（公开接口，模拟模式也用真实数据）
const guestPrices = () => call(`/guest/prices?product=${PRODUCT}`, false);

const real = {
  buy: (country, operator) =>
    call(`/user/buy/activation/${encodeURIComponent(country)}/${encodeURIComponent(operator)}/${PRODUCT}`),
  check: (id) => call(`/user/check/${id}`),
  finish: (id) => call(`/user/finish/${id}`),
  cancel: (id) => call(`/user/cancel/${id}`),
  ban: (id) => call(`/user/ban/${id}`),
  profile: () => call('/user/profile'),
};

// ---- 本地模拟（FIVESIM_MOCK=1），不花钱测试完整流程 ----
const mockOrders = new Map();
let mockSeq = 100000;
const view = ({ willReceive, smsAt, ...o }) => structuredClone(o);
const mockDial = (country) => ({ greece: '30', austria: '43', netherlands: '31', england: '44', usa: '1', vietnam: '84' })[country] || '44';
const mustGet = (id) => {
  const o = mockOrders.get(Number(id));
  if (!o) throw new FiveSimError('order not found', 404);
  return o;
};
const mock = {
  // successRate：该线路的预估成功率（0–100），用来模拟真实的收码概率
  async buy(country, operator, { cost = 0.15, successRate = 50 } = {}) {
    const now = Date.now();
    const rate = config.fivesim.mockSmsRate ?? successRate / 100;
    const o = {
      id: ++mockSeq,
      phone: '+' + mockDial(country) + String(6900000000 + Math.floor(Math.random() * 99999999)),
      operator,
      product: PRODUCT,
      price: cost,
      status: 'PENDING',
      expires: new Date(now + 15 * 60e3).toISOString(),
      sms: null,
      created_at: new Date(now).toISOString(),
      country,
      willReceive: Math.random() < rate,
      smsAt: now + config.fivesim.mockSmsDelaySec * 1000,
    };
    mockOrders.set(o.id, o);
    return view(o);
  },
  async check(id) {
    const o = mustGet(id);
    const now = Date.now();
    if (o.status === 'PENDING' && o.willReceive && now >= o.smsAt) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      o.status = 'RECEIVED';
      o.sms = [{ created_at: new Date().toISOString(), date: new Date().toISOString(), sender: 'OpenAI', text: `Your OpenAI verification code is: ${code}`, code }];
    }
    if (o.status === 'PENDING' && now > Date.parse(o.expires)) o.status = 'TIMEOUT';
    return view(o);
  },
  async finish(id) {
    const o = mustGet(id);
    o.status = 'FINISHED';
    return view(o);
  },
  async cancel(id) {
    const o = mustGet(id);
    if (o.sms) throw new FiveSimError('order has sms', 400);
    o.status = 'CANCELED';
    return view(o);
  },
  async ban(id) {
    const o = mustGet(id);
    if (o.sms) throw new FiveSimError('order has sms', 400);
    o.status = 'BANNED';
    return view(o);
  },
  profile: async () => ({ email: 'mock@example.com', balance: 999, rating: 96 }),
};

const api = config.fivesim.mock ? mock : real;

// 这些错误说明这条线路暂时买不到，换下一条试
const TRY_NEXT = /no free phones|bad country|bad operator|no product|select country|select operator/i;

module.exports = { ...api, guestPrices, TRY_NEXT, FiveSimError };
