# gpt-verify

闲鱼发 CDK → 用户在 `gptsuchong.com/sms` 输入 CDK → 自动从 5SIM 买号 → 页面实时显示验证码。

- Node.js ≥ 22.13，**零依赖**（使用 Node 自带的 `node:sqlite`）
- 数据存在 `data/app.db`（SQLite）
- 用户页：`/sms`，管理后台：`/sms/admin`

## 流程与规则

| 场景 | 行为 |
|---|---|
| 第一次输入 CDK | 从「线路排行」得分最高、且单价 ≤ `PRICE_CAP` 的线路买号（没号自动试下一条） |
| 换号 | 跳过该用户失败过的线路；第 `ESCALATE_AFTER`+1 次起单价上限放宽到 `PRICE_CAP_RETRY` |
| 线路熔断 | 同一线路 1 小时内连续失败 `BREAKER_FAILS` 单，暂停 `BREAKER_PAUSE_MIN` 分钟 |
| 刷新页面 / 换设备 | 输入同一个 CDK 恢复当前状态，不会重复买号 |
| 收到验证码 | 后端每 2 秒查 5SIM，通过 SSE 立刻推送到页面；CDK 标记为已使用 |
| 没收到码，换号 | 取号满 `SWAP_COOLDOWN_SEC` 秒后可点；取消旧号（5SIM 退款）再买新号 |
| 号码被拒，换号 | 无需等待；拉黑旧号后优先换国家，其次换运营商；该 CDK 不再使用已被拒的线路，无其他合适线路时提示稍后重试或联系客服 |
| 号码超时 | 5SIM 自动结束并退款；页面提示「获取新号码」，计入次数 |
| 次数用完 | 每个 CDK 最多取号 `1 + MAX_SWAPS` 次，用完提示联系客服；后台可「+1 换号次数」 |
| 换号时买号失败 | 不扣次数，用户稍后点「获取新号码」重试 |
| 输错 CDK | 同一 IP 10 分钟内错 20 次后暂时封禁 |

后端重启不影响进行中的订单：启动后会继续轮询数据库里未结束的订单。

被拒线路的排除只针对当前 CDK，不影响其他用户；原 `REJECT_SKIP` 配置不再生效。没收到码的冷却时间和线路重试规则保持不变。

## 本地试跑（模拟 5SIM，不花钱）

```bash
cp .env.example .env
# 编辑 .env：FIVESIM_MOCK=1，ADMIN_TOKEN=随便设一个
npm start
```

打开 http://127.0.0.1:3000/sms/admin 生成 CDK，再到 http://127.0.0.1:3000/sms 使用。
模拟模式使用 5SIM 真实的线路数据，按各线路预估成功率模拟是否收到码，15 秒后到达（`MOCK_SMS_RATE` 可强制指定 0–1 的成功率，`MOCK_SMS_DELAY_SEC` 调到达时间）。

## 部署（日本服务器 + 宝塔面板）

代码推到 GitHub 后，GitHub Actions 自动构建镜像（`.github/workflows/docker.yml`），推到 `ghcr.io/weizhixiong123/gpt-verify`。服务器只需要三个文件：`docker-compose.yml`、`env.production.example`、`update.sh`。域名、HTTPS、反向代理在宝塔里配置。

### 1. 推到 GitHub

在 GitHub 新建仓库（建议 **Private**），然后在本机项目目录：

```bash
git init -b main
git add .
git commit -m "init"
git remote add origin https://github.com/Weizhixiong123/gpt-verify.git
git push -u origin main
```

打开仓库的「Actions」页，等「Build image」变绿（1–2 分钟），镜像就在仓库首页右侧「Packages」里。

### 2. 服务器拉镜像并启动

1. 宝塔「文件」→ 新建目录 `/opt/gpt-verify/`，上传 `docker-compose.yml`、`env.production.example`、`update.sh`
2. 宝塔「终端」：

```bash
cd /opt/gpt-verify
cp env.production.example .env
vim .env                      # 必填 ADMIN_TOKEN（openssl rand -base64 24 生成）和 FIVESIM_TOKEN
chmod +x update.sh

# 仓库是 Private 时镜像也私有，登录一次（密码填 GitHub token，只需 read:packages 权限，
# 在 GitHub「Settings → Developer settings → Personal access tokens → Tokens (classic)」新建）
docker login ghcr.io -u Weizhixiong123

./update.sh                   # 拉镜像、启动、等健康检查通过
```

**以后更新**：本机 `git push` → 等 Actions 变绿 → 服务器 `cd /opt/gpt-verify && ./update.sh`（`.env` 和数据库都保留）。

### 3. 添加站点

宝塔「网站」→「添加站点」：

- 域名：`gptsuchong.com`（如果 DNS 配了 www，再加一行 `www.gptsuchong.com`）
- PHP 版本：纯静态；数据库：不创建

### 4. 申请 HTTPS 证书

站点「设置」→「SSL」→「Let's Encrypt」→ 勾选域名 → 申请 → 打开「强制 HTTPS」。

### 5. 反向代理

站点「设置」→「反向代理」→「添加反向代理」：

- 代理名称：`gpt-verify`
- 目标 URL：`http://127.0.0.1:3000`
- 发送域名：`$host`
- 代理目录：`/`（高级选项里；默认就是 `/`）

保存后，点这条反向代理的「配置文件」，把内容**整个替换**为（关键是关闭缓冲，否则验证码不能实时推送）：

```nginx
location = / {
    return 302 /sms;
}

location ^~ / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
}
```

### 6. 验证

- `https://gptsuchong.com` 会自动跳到 `https://gptsuchong.com/sms`
- `https://gptsuchong.com/sms/admin` 登录后能看到 5SIM 余额
- 宝塔「安全」里**不需要**放行 3000 端口（容器只监听本机）

### 常用操作（宝塔终端，在 `/opt/gpt-verify` 下）

```bash
./update.sh                   # 更新到 GitHub 最新构建的版本
docker compose up -d          # 只改了 .env 时，重新加载配置
docker compose logs -f        # 看日志，Ctrl+C 退出
docker compose down           # 停止（数据保留）

# 备份数据库
docker compose cp gpt-verify:/app/data/app.db ./backup-$(date +%F).db
```

- 数据库保存在 Docker 卷 `data` 里，重建、升级容器都不会丢失。
- 端口 3000 被占用时，在 `.env` 里加 `HOST_PORT=3001`，反向代理的目标 URL 也改成 3001。
- 「今日」统计按北京时间计算。
- 如果套了 Cloudflare：SSE 可以正常工作（服务端每 20 秒发心跳保持连接）。

## 对接 xianyu-auto-reply

1. 打开 `/sms/admin`，输入 `ADMIN_TOKEN`
2. 「生成 CDK」：填数量，导出格式选「CDK + 使用链接」，点生成 → 复制全部
3. 粘贴到 xianyu-auto-reply 的卡券库存（每行一张）

买家收到的内容形如：

```
CDK：ABCD-EFGH-JKLM-NPQR　使用地址：https://gptsuchong.com/sms?cdk=ABCD-EFGH-JKLM-NPQR
```

点链接会自动填入 CDK 并取号。

## 线路选择

每 10 分钟从 5SIM 公开接口拉取 openai 项目所有「国家 + 运营商」线路的价格、库存和分时成功率，计算得分：

- 5SIM 得分 = 24 小时成功率 × 0.5 + 7 天 × 0.3 + 30 天 × 0.2
- 本站得分 = 最近 7 天本站该线路的 (成功 + 1) / (总数 + 2)
- 综合得分 = 两者加权，本站样本越多权重越大（20 单以上占 70%）

5SIM 只对收到验证码的号码扣费，取消/超时全额退款，所以排序以成功率为主，价格上限只防止异常高价。后台「线路排行」可以看到实时排名、本站成功率和熔断状态。

## 配置项

见 `.env.example`，常用的：

- `PRICE_CAP` / `PRICE_CAP_RETRY` / `ESCALATE_AFTER`：前几次取号的单价上限、试错后放宽的上限
- `EXCLUDE_COUNTRIES`：不想用的国家
- `MAX_SWAPS`：每个 CDK 的换号次数（默认 10）
- `SWAP_COOLDOWN_SEC`：取号后多久可以换号（默认 120 秒）

## 文件结构

```
server.js          HTTP 路由、SSE、管理接口
lib/config.js      读取 .env
lib/db.js          SQLite 表结构与查询
lib/fivesim.js     5SIM API 封装 + 模拟模式
lib/routes.js      线路排序（实时成功率、本站统计、熔断）
lib/service.js     CDK / 买号 / 换号 / 轮询 核心逻辑
public/sms.html    用户页面
public/admin.html  管理后台

Dockerfile                    镜像构建（GitHub Actions 用）
.github/workflows/docker.yml  push 到 main 自动构建并推送到 ghcr.io
docker-compose.yml            服务器：拉镜像运行
env.production.example        服务器：.env 模板
update.sh                     服务器：部署 / 更新
```
