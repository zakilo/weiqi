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
  echo "[deploy] 未找到 nginx。本机 Intel macOS 无法用 brew 安装(无预编译包且 GitHub 源被网络中断),"
  echo "         源码安装步骤(nginx.org 可达,无需 sudo,不含 PCRE 故禁用 rewrite 模块):"
  echo "           curl -sL -o /tmp/nginx.tar.gz https://nginx.org/download/nginx-1.27.4.tar.gz"
  echo "           tar xzf /tmp/nginx.tar.gz -C /tmp && cd /tmp/nginx-1.27.4"
  echo "           ./configure --prefix=\$HOME/weiqi-nginx --sbin-path=\$HOME/weiqi-nginx/bin/nginx \\"
  echo "             --conf-path=\$HOME/weiqi-nginx/nginx.conf --pid-path=\$HOME/weiqi-nginx/logs/nginx.pid \\"
  echo "             --error-log-path=\$HOME/weiqi-nginx/logs/error.log --http-log-path=\$HOME/weiqi-nginx/logs/access.log \\"
  echo "             --without-http_rewrite_module --with-http_stub_status_module --with-threads"
  echo "           make -j4 && make install"
  exit 1
fi
if [ "$NGINX_BIN" = "$HOME/weiqi-nginx/bin/nginx" ]; then
  MAIN_CONF="$HOME/weiqi-nginx/nginx.conf"
  NGINX_HOME="$HOME/weiqi-nginx"
else
  NGINX_HOME="$(dirname "$(dirname "$NGINX_BIN")")"
  MAIN_CONF="$NGINX_HOME/etc/nginx/nginx.conf"
fi
[ -f "$MAIN_CONF" ] || { echo "[deploy] 找不到主配置 $MAIN_CONF"; exit 1; }

PASSWD_FILE="$NGINX_HOME/conf.d/weiqi.passwd"
CRED_FILE="$NGINX_HOME/conf.d/credentials.txt"

# 1. 前端产物
cd "$PROJECT_DIR" && npm run build

# 2. AI 服务:优先交给 launchd 常驻(开机自启、异常自动拉起)
AI_LABEL="com.weiqi.aiservice"
AI_PLIST="$HOME/Library/LaunchAgents/$AI_LABEL.plist"
SERVICE_LISTEN=$(lsof -iTCP:8080 -sTCP:LISTEN -P 2>/dev/null | awk 'NR==2{print $9}' || true)
launchctl kickstart -k "gui/$(id -u)/$AI_LABEL" 2>/dev/null || true
if [ -f "$AI_PLIST" ] && launchctl print "gui/$(id -u)/$AI_LABEL" >/dev/null 2>&1; then
  # kickstart 后端口需要一两秒回来,轮询确认再报告
  for _ in $(seq 1 15); do
    SERVICE_LISTEN=$(lsof -iTCP:8080 -sTCP:LISTEN -P 2>/dev/null | awk 'NR==2{print $9}' || true)
    [ -n "$SERVICE_LISTEN" ] && break
    sleep 1
  done
  echo "[deploy] AI 服务由 launchd 常驻:$SERVICE_LISTEN"
elif [ -z "$SERVICE_LISTEN" ] || [ "$RESTART_SERVICE" = 1 ]; then
  # 兜底:未装 LaunchAgent 时前台后台拉起一次(重启机器不会自动恢复)
  pkill -f "weiqi/server/index.ts" 2>/dev/null || true
  sleep 1
  nohup node server/index.ts > /tmp/weiqi-server.log 2>&1 &
  sleep 3
  echo "[deploy] AI 服务已启动(nohup): $(lsof -iTCP:8080 -sTCP:LISTEN -P 2>/dev/null | awk 'NR==2{print $9}')"
  echo "[deploy] 提示:建议改用 launchd 常驻,重启后才会自动恢复"
else
  echo "[deploy] AI 服务已在 $SERVICE_LISTEN 运行"
fi
if echo "${SERVICE_LISTEN:-}" | grep -q '^\*'; then
  echo "[deploy] 警告:AI 服务监听在所有网卡,请检查 ai.config.json 的 host 应为 127.0.0.1"
fi

# 3. 渲染站点配置(模板 → 本机路径,产物不入库)并 include 进 http{}
SITE_CONF="$PROJECT_DIR/deploy/nginx-weiqi.local.conf"
sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" -e "s|__NGINX_HOME__|$NGINX_HOME|g" \
  "$PROJECT_DIR/deploy/nginx-weiqi.conf.template" > "$SITE_CONF"
mkdir -p "$NGINX_HOME/logs"
echo "[deploy] 已渲染站点配置:$SITE_CONF"

# 迁移:老版本直接把带绝对路径的 deploy/nginx-weiqi.conf include 进了主配置
if grep -q "deploy/nginx-weiqi\.local\.conf" "$MAIN_CONF"; then
  :
elif grep -q "nginx-weiqi\.conf" "$MAIN_CONF"; then
  sed -i '' "s|nginx-weiqi\.conf;|nginx-weiqi.local.conf;|" "$MAIN_CONF"
  echo "[deploy] 主配置 include 已切换到渲染后的配置"
else
  awk -v inc="    include $SITE_CONF;" '
    { lines[NR] = $0; if ($0 == "}") last = NR }
    END {
      if (!last) { print "[deploy] 主配置未找到 http 块结尾,请手动 include " inc > "/dev/stderr"; exit 1 }
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
