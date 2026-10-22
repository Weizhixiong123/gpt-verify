const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
const db = new DatabaseSync(config.dbFile);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS cdks (
    code         TEXT PRIMARY KEY,
    status       TEXT NOT NULL DEFAULT 'unused',  -- unused | active | used | disabled
    extra_swaps  INTEGER NOT NULL DEFAULT 0,      -- 客服额外补的换号次数
    batch        TEXT,
    created_at   INTEGER NOT NULL,
    activated_at INTEGER,
    used_at      INTEGER
  );

  CREATE TABLE IF NOT EXISTS orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    cdk         TEXT NOT NULL REFERENCES cdks(code),
    fivesim_id  INTEGER NOT NULL,
    phone       TEXT NOT NULL,
    country     TEXT,
    operator    TEXT,
    price       REAL,
    status      TEXT NOT NULL,  -- pending | received | finished | canceled | banned | timeout
    code        TEXT,
    sms_text    TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_orders_cdk ON orders(cdk);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
`);

// 旧库升级：买号时线路的预估接码成功率
if (!db.prepare('PRAGMA table_info(orders)').all().some((c) => c.name === 'est_rate')) {
  db.exec('ALTER TABLE orders ADD COLUMN est_rate REAL');
}
// 旧库升级：CDK 导出（复制去发货）的时间，防止同一批重复贴进卡券库存
if (!db.prepare('PRAGMA table_info(cdks)').all().some((c) => c.name === 'exported_at')) {
  db.exec('ALTER TABLE cdks ADD COLUMN exported_at INTEGER');
}
// 旧库升级：用户自助注销 CDK（申请退款）的时间
if (!db.prepare('PRAGMA table_info(cdks)').all().some((c) => c.name === 'voided_at')) {
  db.exec('ALTER TABLE cdks ADD COLUMN voided_at INTEGER');
}
// 旧库升级：通过取卡接口发货（xianyu-auto-reply「API接口」卡券）的卖出时间和闲鱼订单号
if (!db.prepare('PRAGMA table_info(cdks)').all().some((c) => c.name === 'sold_at')) {
  db.exec('ALTER TABLE cdks ADD COLUMN sold_at INTEGER');
  db.exec('ALTER TABLE cdks ADD COLUMN order_ref TEXT');
}
// 同一个订单只发一个 CDK（重复调用返回同一个）
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_cdks_order_ref ON cdks(order_ref) WHERE order_ref IS NOT NULL');

// 闲管家货源订单：管家订单号 ↔ 我们的货源订单号 ↔ 闲鱼订单号 ↔ 发出的 CDK
db.exec(`
  CREATE TABLE IF NOT EXISTS xgj_orders (
    order_no      TEXT PRIMARY KEY,       -- 管家订单号
    out_order_no  TEXT NOT NULL UNIQUE,   -- 货源订单号（我们生成）
    biz_order_no  TEXT,                   -- 闲鱼订单号
    goods_no      TEXT NOT NULL,
    quantity      INTEGER NOT NULL,
    amount        INTEGER NOT NULL,       -- 订单金额（分）
    codes         TEXT NOT NULL,          -- 发出的 CDK（JSON 数组）
    created_at    INTEGER NOT NULL,
    refund_at     INTEGER,
    refund_amount INTEGER
  );
`);

const q = {
  getCdk: db.prepare('SELECT * FROM cdks WHERE code = ?'),
  insertCdk: db.prepare('INSERT INTO cdks (code, batch, created_at) VALUES (?, ?, ?)'),
  activateCdk: db.prepare(
    "UPDATE cdks SET status = 'active', activated_at = ? WHERE code = ? AND status = 'unused'"
  ),
  useCdk: db.prepare(
    "UPDATE cdks SET status = 'used', used_at = ? WHERE code = ? AND status IN ('unused', 'active')"
  ),
  setCdkStatus: db.prepare('UPDATE cdks SET status = ? WHERE code = ?'),
  voidCdk: db.prepare("UPDATE cdks SET status = 'voided', voided_at = ? WHERE code = ? AND status IN ('unused', 'active')"),
  insertSoldCdk: db.prepare(
    'INSERT INTO cdks (code, batch, created_at, exported_at, sold_at, order_ref) VALUES (?1, ?2, ?3, ?3, ?3, ?4)'
  ),
  cdkByOrderRef: db.prepare('SELECT * FROM cdks WHERE order_ref = ?'),
  countSold: db.prepare("SELECT COUNT(*) AS n FROM cdks WHERE status = 'unused' AND sold_at IS NOT NULL"),
  // 导出给卡券仓库的只算还没卖出的（接口发出去的已经在买家手里了）
  unusedCdks: db.prepare(`
    SELECT code FROM cdks
    WHERE status = 'unused' AND sold_at IS NULL AND (?1 = 1 OR exported_at IS NULL)
    ORDER BY created_at, rowid
  `),
  markExported: db.prepare('UPDATE cdks SET exported_at = ? WHERE code = ?'),
  countUnexported: db.prepare(
    "SELECT COUNT(*) AS n FROM cdks WHERE status = 'unused' AND sold_at IS NULL AND exported_at IS NULL"
  ),
  addExtraSwaps: db.prepare('UPDATE cdks SET extra_swaps = MAX(0, extra_swaps + ?) WHERE code = ?'),

  ordersByCdk: db.prepare('SELECT * FROM orders WHERE cdk = ? ORDER BY id DESC'),
  getOrder: db.prepare('SELECT * FROM orders WHERE id = ?'),
  liveOrders: db.prepare("SELECT * FROM orders WHERE status IN ('pending', 'received')"),
  insertOrder: db.prepare(`
    INSERT INTO orders (cdk, fivesim_id, phone, country, operator, price, est_rate, status, created_at, expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `),
  setOrderStatus: db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?'),
  setOrderSms: db.prepare(
    "UPDATE orders SET status = 'received', code = ?, sms_text = ?, updated_at = ? WHERE id = ?"
  ),

  recentOutcomes: db.prepare(
    'SELECT cdk, country, operator, status, updated_at FROM orders WHERE created_at > ? ORDER BY updated_at DESC'
  ),

  orderStatsSince: db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(status IN ('received', 'finished')) AS ok,
      SUM(status IN ('canceled', 'banned', 'timeout')) AS fail,
      SUM(status = 'released') AS released,
      SUM(status = 'pending') AS pending,
      COALESCE(SUM(CASE WHEN status IN ('received', 'finished') THEN price END), 0) AS spend
    FROM orders WHERE created_at >= ?
  `),
  listOrders: db.prepare(`
    SELECT * FROM orders
    WHERE (?1 = '' OR status = ?1) AND (?2 = '' OR cdk LIKE ?2 OR phone LIKE ?2)
    ORDER BY id DESC LIMIT ?3
  `),

  countByStatus: db.prepare('SELECT status, COUNT(*) AS n FROM cdks GROUP BY status'),
  listCdks: db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM orders o WHERE o.cdk = c.code AND o.status != 'released') AS order_count,
      (SELECT o.status FROM orders o WHERE o.cdk = c.code ORDER BY o.id DESC LIMIT 1) AS last_status
    FROM cdks c
    WHERE (?1 = ''
        OR (?1 = 'sold' AND c.status = 'unused' AND c.sold_at IS NOT NULL)
        OR (?1 = 'unused' AND c.status = 'unused' AND c.sold_at IS NULL)
        OR (?1 NOT IN ('sold', 'unused') AND c.status = ?1))
      AND (?2 = '' OR c.code LIKE ?2 OR c.batch = ?3 OR c.order_ref = ?3)
    -- 未使用的排最前（方便复制去发货），然后是进行中、已完成、已停用；同一状态内新的在前
    ORDER BY CASE c.status WHEN 'unused' THEN 0 WHEN 'active' THEN 1 WHEN 'used' THEN 2 ELSE 3 END,
             c.created_at DESC, c.rowid DESC
    LIMIT ?4
  `),
};

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, q, transaction };
