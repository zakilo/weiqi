#!/bin/bash
# 一键部署/重启围棋站点:AI 服务 + nginx
# 用法: bash deploy/start.sh [--restart]   (--restart 强制重启 AI 服务)
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RESTART_SERVICE=0
[ "${1:-}" = "--restart" ] && RESTART_SERVICE=1

# 定位 nginx:优先源码安装版(用户目录),其次 brew 版
NGINX_BIN=""
for c in "$HOME/weiqi-nginx/bin/nginx" /usr/local/bin/nginx /opt/homebrew/bin/nginx; do
  if [ -x "$c" ]; then NGINX_BIN="$c"; break; fi
done
if [ -z "$NGINX_BIN" ]; then
  echo "[deploy] 未找到 nginx。安装见 deploy/README.md"
  exit 1
fi
if [ "$NGINX_BIN" = "$HOME/weiqi-nginx/bin/nginx" ]; then
  MAIN_CONF="$HOME/weiqi-nginx/nginx.conf"
else
  MAIN_CONF="$(dirname "$(dirname "$NGINX_BIN")")/etc/nginx/nginx.conf"
fi
[ -f "$MAIN_CONF" ] || { echo "[deploy] 找不到主配置 $MAIN_CONF"; exit 1; }

PASSWD_FILE="$HOME/weiqi-nginx/conf.d/weiqi.passwd"
CRED_FILE="$HOME/weiqi-nginx/conf.d/credentials.txt"

# 1. 前端产物
cd "$PROJECT_DIR" && npm run build

# 2. AI 服务:只应监听 127.0.0.1;需要重启或绑定不对时重新拉起
SERVICE_LISTEN=$(lsof -iTCP:8080 -sTCP:LISTEN -P 2>/dev/null | awk 'NR==2{print $9}' || true)
if [ "$RESTART_SERVICE" = 1 ] && [ -n "$SERVICE_LISTEN" ]; then
  pkill -f "node server/index.ts" 2>/dev/null || true
  sleep 1
  SERVICE_LISTEN=""
fi
if [ -z "$SERVICE_LISTEN" ]; then
  nohup node server/index.ts > /tmp/weiqi-server.log 2>&1 &
  sleep 2
  echo "[deploy] AI 服务已启动: $(lsof -iTCP:8080 -sTCP:LISTEN -P 2>/dev/null | awk 'NR==2{print $9}')"
elif echo "$SERVICE_LISTEN" | grep -q '\*'; then
  echo "[deploy] 检测到 AI 服务监听所有网卡($SERVICE_LISTEN),正在按新配置重启"
  bash "$0" --restart
  exit $?
else
  echo "[deploy] AI 服务已在 $SERVICE_LISTEN 运行,跳过"
fi

# 3. 站点配置 include 进 http{}（只加一次,插在最后一个顶格 } 之前）
if ! grep -q "nginx-weiqi.conf" "$MAIN_CONF"; then
  awk -v inc="    include $PROJECT_DIR/deploy/nginx-weiqi.conf;" '
    { lines[NR] = $0; if ($0 == "}") last = NR }
    END {
      if (!last) { print "[deploy] 主配置未找到 http 块结尾,请手动 include" > "/dev/stderr"; exit 1 }
      lines[last] = inc "\n" lines[last]
      for (i = 1; i <= NR; i++) print lines[i]
    }
  ' "$MAIN_CONF" > "$MAIN_CONF.tmp"
  mv "$MAIN_CONF.tmp" "$MAIN_CONF"
  echo "[deploy] 已写入站点 include"
fi

# 4. 口令文件检查
if [ ! -f "$PASSWD_FILE" ]; then
  echo "[deploy] 缺少密码文件 $PASSWD_FILE"
  echo "  生成: mkdir -p ~/weiqi-nginx/conf.d"
  echo "        printf '用户名:%s\n' \"\$(openssl passwd -apr1 你的口令)\" > $PASSWD_FILE"
  exit 1
fi
chmod 600 "$PASSWD_FILE"

# 5. 校验并生效
"$NGINX_BIN" -t
if pgrep -f "weiqi-nginx/bin/nginx" >/dev/null 2>&1; then
  "$NGINX_BIN" -s reload
  echo "[deploy] nginx 已重载(launchd 托管,异常自动拉起)"
else
  "$NGINX_BIN"
  echo "[deploy] nginx 已启动"
fi

# 6. 自检(整站有 Basic Auth,需带口令)
sleep 1
AUTH=""
if [ -f "$CRED_FILE" ]; then
  U=$(awk -F': ' '/^用户名/{print $2}' "$CRED_FILE")
  P=$(awk -F': ' '/^密码/{print $2}' "$CRED_FILE")
  AUTH="-u $U:$P"
fi
for path in / /api/health /api/models; do
  code=$(eval curl -fsS -o /dev/null -w "'%{http_code}'" "$AUTH" "http://localhost$path" 2>/dev/null || echo 000)
  echo "[deploy] 自检 $path -> HTTP $code"
done
# 未授权必须 401
noauth=$(curl -s -o /dev/null -w '%{http_code}' http://localhost/api/models)
echo "[deploy] 无口令访问 /api/models -> HTTP $noauth (期望 401)"
echo "[deploy] 站点入口: http://localhost  (登录口令见 $CRED_FILE)"
