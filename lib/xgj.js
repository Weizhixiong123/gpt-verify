// 闲管家「虚拟货源标准接口」：我们作为货源方（只有一个卡密商品：接码 CDK）。
// 闲鱼买家付款 → 闲管家调用「创建卡密订单」→ 我们返回 CDK → 闲管家发给买家。
// 文档：https://s.apifox.cn/apidoc/shared/cf4d53fd-8bb2-41c5-8da3-371ba9a38956
const crypto = require('node:crypto');
const config = require('./config');
const { db } = require('./db');
const service = require('./service');

const X = config.xgj;
const enabled = () => Boolean(X.appId && X.appSecret && X.mchId && X.mchSecret);

const q = {
  get: db.prepare('SELECT * FROM xgj_orders WHERE order_no = ?'),
  getByOut: db.prepare('SELECT * FROM xgj_orders WHERE out_order_no = ?'),
  insert: db.prepare(`
    INSERT INTO xgj_orders (order_no, out_order_no, biz_order_no, goods_no, quantity, amount, codes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  refund: db.prepare('UPDATE xgj_orders SET refund_at = ?, refund_amount = ? WHERE order_no = ?'),
};

// 业务错误：闲管家只认响应体里的 code（0 才算成功），HTTP 状态一律 200
class XgjError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const sec = (ms) => Math.floor(ms / 1000);

// 签名：sign = md5("app_id,app_secret,md5(body),timestamp,mch_id,mch_secret")
function verify(url, rawBody) {
  const mchId = url.searchParams.get('mch_id') || '';
  const timestamp = Number(url.searchParams.get('timestamp'));
  const sign = (url.searchParams.get('sign') || '').toLowerCase();
  if (mchId !== X.mchId) throw new XgjError(1000, '商户不存在');
  if (!timestamp || Math.abs(sec(Date.now()) - timestamp) > 300) throw new XgjError(408, '时间戳已过期');
  const bodyMd5 = md5(rawBody || '');
  const want = md5([X.appId, X.appSecret, bodyMd5, timestamp, X.mchId, X.mchSecret].join(','));
  const a = Buffer.from(sign);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new XgjError(401, '签名错误');
}

function goods() {
  return {
    goods_no: X.goodsNo,
    goods_type: 2, // 卡密商品
    goods_name: X.goodsName,
    price: X.price,
    stock: 999999, // CDK 现取现发，不限库存
    status: 1, // 在架
    update_time: sec(Date.now()),
    template: [],
  };
}

function requireGoods(goodsNo) {
  if (goodsNo !== X.goodsNo) throw new XgjError(1100, '商品不存在');
}

function orderView(row) {
  const codes = JSON.parse(row.codes);
  const view = {
    order_no: row.order_no,
    out_order_no: row.out_order_no,
    order_type: 2,
    order_status: 20, // 已成功：CDK 当场生成，同步出卡
    order_amount: row.amount,
    order_time: sec(row.created_at),
    end_time: sec(row.created_at),
    goods_no: row.goods_no,
    goods_name: X.goodsName,
    buy_quantity: row.quantity,
    card_items: codes.map((c) => ({ card_pwd: c })),
    remark: '',
  };
  if (row.refund_at) {
    view.refund_status = 20; // 退款成功
    view.refund_amount = row.refund_amount || 0;
    view.refund_time = sec(row.refund_at);
  }
  return view;
}

const handlers = {
  // 查询平台信息（不签名）
  'open/info': () => ({
    app_id: Number(X.appId),
    features: {
      is_support_goods_notify: false,
      is_support_order_refund: false,
      is_support_loss_purchase: true,
    },
  }),

  // 查询商户信息：自己给自己供货，余额给一个足够大的数
  'user/info': () => ({ balance: 100000000 }),

  'goods/list': (body) => {
    const kw = String(body.keyword || '').trim();
    const g = goods();
    const hit = (!body.goods_type || Number(body.goods_type) === 2) && (!kw || g.goods_no === kw || g.goods_name.includes(kw));
    return { list: hit ? [g] : [], count: hit ? 1 : 0 };
  },

  'goods/detail': (body) => {
    requireGoods(body.goods_no);
    return goods();
  },

  // 创建卡密订单：同一个管家订单号重复调用，返回同一批 CDK
  'order/purchase/create': (body) => {
    const orderNo = String(body.order_no || '').trim();
    if (!orderNo) throw new XgjError(1200, '缺少管家订单号');
    const existing = q.get.get(orderNo);
    if (existing) return orderView(existing);

    requireGoods(body.goods_no);
    const quantity = Math.max(1, Math.min(Number(body.buy_quantity) || 1, 20));
    const amount = X.price * quantity;
    if (body.max_amount != null && amount > Number(body.max_amount)) throw new XgjError(1201, '订单金额超过安全价');

    // CDK 的订单号记成闲鱼订单号，后台「已卖未使用」可按闲鱼订单号搜索
    const ref = String(body.biz_order_no || orderNo).trim();
    const codes = [];
    for (let i = 0; i < quantity; i++) codes.push(service.issueCard(i === 0 ? ref : `${ref}#${i + 1}`));

    const outOrderNo = `GV${Date.now()}${crypto.randomInt(1000, 9999)}`;
    try {
      q.insert.run(orderNo, outOrderNo, body.biz_order_no || null, X.goodsNo, quantity, amount, JSON.stringify(codes), Date.now());
    } catch (err) {
      // 同一订单并发进来两次：返回先写入的那个
      if (/UNIQUE/.test(err.message) && q.get.get(orderNo)) return orderView(q.get.get(orderNo));
      throw err;
    }
    console.log(`[xgj] 订单 ${orderNo}（闲鱼 ${body.biz_order_no || '-'}）发货 ${codes.join(',')}`);
    return orderView(q.get.get(orderNo));
  },

  'order/detail': (body) => {
    const row = body.order_no ? q.get.get(String(body.order_no)) : q.getByOut.get(String(body.out_order_no || ''));
    if (!row) throw new XgjError(1202, '订单不存在');
    return orderView(row);
  },

  // 订单退款通知：闲鱼退款成功后闲管家通知我们，把这单发出的 CDK 作废（正在等码的号码会先取消）
  'order/refund/notify': async (body) => {
    const row = q.get.get(String(body.order_no || '')) || q.getByOut.get(String(body.out_order_no || ''));
    if (!row) return { __raw: { result: 'success', msg: '订单不存在，已忽略' } };
    for (const code of JSON.parse(row.codes)) {
      try {
        await service.disableCdk(code);
      } catch (err) {
        console.error(`[xgj] 退款作废 ${code} 失败: ${err.message}`);
      }
    }
    q.refund.run(Date.now(), Number(body.refund_amount) || row.amount, row.order_no);
    console.log(`[xgj] 订单 ${row.order_no} 已退款，作废 ${row.codes}`);
    return { __raw: { result: 'success', msg: '接收成功' } };
  },
};

// route 形如 /goofish/order/purchase/create
// 每次调用都记一行日志（路径、来源 IP、请求体、返回 code），方便和闲管家联调排查
async function handle(route, url, rawBody, clientIp) {
  const res = await dispatch(route, url, rawBody, clientIp);
  const brief = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 300);
  console.log(`[xgj] ${route} ip=${clientIp} body=${brief(rawBody)} -> code=${res.code ?? res.result} ${brief(JSON.stringify(res.data ?? res.msg))}`);
  return res;
}

async function dispatch(route, url, rawBody, clientIp) {
  try {
    if (!enabled()) throw new XgjError(404, '闲管家接口未开启');
    if (X.ipWhitelist.length && !X.ipWhitelist.includes(clientIp)) throw new XgjError(403, 'IP 不在白名单');
    const name = route.replace(/^\/goofish\//, '');
    const fn = handlers[name];
    if (!fn) throw new XgjError(404, '接口不存在');
    if (name !== 'open/info') verify(url, rawBody);
    let body = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw new XgjError(400, '请求体不是合法 JSON');
      }
    }
    const data = await fn(body);
    if (data && data.__raw) return data.__raw;
    return { code: 0, msg: 'OK', data };
  } catch (err) {
    if (err instanceof XgjError) return { code: err.code, msg: err.message };
    console.error('[xgj]', err);
    return { code: 500, msg: '系统异常，请重试' };
  }
}

module.exports = { handle, enabled, sign: (rawBody, timestamp) =>
  md5([X.appId, X.appSecret, md5(rawBody || ''), timestamp, X.mchId, X.mchSecret].join(',')) };
