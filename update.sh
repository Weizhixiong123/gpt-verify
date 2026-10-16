#!/usr/bin/env bash
# 部署 / 更新：拉取 GitHub Actions 构建的最新镜像并重启（.env 和数据库保留）
# 首次部署：cp env.production.example .env，填好 ADMIN_TOKEN 和 FIVESIM_TOKEN，再运行 ./update.sh
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  echo "缺少 .env：先执行 cp env.production.example .env，填好 ADMIN_TOKEN 和 FIVESIM_TOKEN" >&2
  exit 1
fi
for key in ADMIN_TOKEN FIVESIM_TOKEN; do
  if ! grep -qE "^${key}=.+" .env; then
    echo ".env 里的 ${key} 没有填写" >&2
    exit 1
  fi
done

if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi

echo "==> 拉取最新镜像"
if ! $DC pull; then
  echo "拉取失败。镜像是私有的话先登录一次（token 只需 read:packages 权限）：" >&2
  echo "  docker login ghcr.io -u Weizhixiong123" >&2
  exit 1
fi

echo "==> 重启"
$DC up -d --remove-orphans
docker image prune -f >/dev/null 2>&1 || true

echo "==> 等待健康检查"
status=starting
for _ in $(seq 1 30); do
  status="$(docker inspect -f '{{.State.Health.Status}}' gpt-verify 2>/dev/null || echo starting)"
  [[ "$status" == healthy ]] && break
  sleep 2
done
$DC ps

if [[ "$status" != healthy ]]; then
  $DC logs --tail 50
  echo "容器没有正常启动，看上面的日志" >&2
  exit 1
fi
echo "==> 完成"
