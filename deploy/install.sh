#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run with sudo: sudo ./deploy/install.sh --domain bridge.example.com" >&2
  exit 1
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source_dir=$(cd -- "${script_dir}/.." && pwd)
domain=""
service_user=${SUDO_USER:-root}
allowed_root=""
telemetry="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) domain=${2:-}; shift 2 ;;
    --user) service_user=${2:-}; shift 2 ;;
    --allowed-root) allowed_root=${2:-}; shift 2 ;;
    --telemetry) telemetry=${2:-}; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z ${domain} ]]; then
  echo "--domain is required and must already point to this VPS" >&2
  exit 1
fi
if ! id "${service_user}" >/dev/null 2>&1; then
  echo "User does not exist: ${service_user}" >&2
  exit 1
fi
service_group=$(id -gn "${service_user}")
if [[ -z ${allowed_root} ]]; then
  allowed_root=$(getent passwd "${service_user}" | cut -d: -f6)
fi
if [[ ! -d ${allowed_root} ]]; then
  echo "Allowed root does not exist: ${allowed_root}" >&2
  exit 1
fi
if [[ ${telemetry} != "true" && ${telemetry} != "false" ]]; then
  echo "--telemetry must be true or false" >&2
  exit 1
fi

for command in node npm tmux openssl systemctl; do
  command -v "${command}" >/dev/null 2>&1 || {
    echo "Missing required command: ${command}" >&2
    exit 1
  }
done
node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
if (( node_major < 22 )); then
  echo "Node.js 22 or newer is required" >&2
  exit 1
fi

install -d -m 0755 /opt/dp-beget-bridge
cp -a "${source_dir}/." /opt/dp-beget-bridge/
cd /opt/dp-beget-bridge
npm ci --omit=dev

install -d -m 0750 -o root -g "${service_group}" /etc/dp-beget-bridge
install -d -m 0700 -o "${service_user}" -g "${service_group}" /var/lib/dp-beget-bridge
env_file=/etc/dp-beget-bridge/bridge.env
if [[ ! -f ${env_file} ]]; then
  agent_token=$(openssl rand -hex 32)
  mcp_token=$(openssl rand -hex 32)
  {
    printf 'DP_AGENT_HOST=127.0.0.1\n'
    printf 'DP_AGENT_PORT=8787\n'
    printf 'DP_AGENT_URL=http://127.0.0.1:8787\n'
    printf 'DP_AGENT_TOKEN=%s\n' "${agent_token}"
    printf 'DP_MCP_HOST=127.0.0.1\n'
    printf 'DP_MCP_PORT=8788\n'
    printf 'DP_MCP_PATH=/mcp\n'
    printf 'DP_MCP_ACCESS_TOKEN=%s\n' "${mcp_token}"
    printf 'DP_PUBLIC_URL=https://%s\n' "${domain}"
    printf 'DP_DATA_DIR=/var/lib/dp-beget-bridge\n'
    printf 'DP_ALLOWED_ROOTS=%s\n' "${allowed_root}"
    printf 'DP_TMUX_SOCKET=/var/lib/dp-beget-bridge/tmux/tmux.sock\n'
    printf 'DP_TELEMETRY_ENABLED=%s\n' "${telemetry}"
    printf 'DP_LOG_LEVEL=info\n'
  } > "${env_file}"
  chmod 0640 "${env_file}"
  chown root:"${service_group}" "${env_file}"
fi

sed \
  -e "s|__DP_USER__|${service_user}|g" \
  -e "s|__DP_GROUP__|${service_group}|g" \
  -e "s|__DP_ALLOWED_ROOT__|${allowed_root}|g" \
  deploy/systemd/dp-beget-agent.service > /etc/systemd/system/dp-beget-agent.service
sed \
  -e "s|__DP_USER__|${service_user}|g" \
  -e "s|__DP_GROUP__|${service_group}|g" \
  deploy/systemd/dp-beget-mcp.service > /etc/systemd/system/dp-beget-mcp.service

systemctl daemon-reload
systemctl enable --now dp-beget-agent.service dp-beget-mcp.service

echo
echo "DP Beget Bridge services are running."
echo "Configure HTTPS reverse proxy ${domain} -> 127.0.0.1:8788 using deploy/Caddyfile.example."
echo "MCP URL: https://${domain}/mcp"
echo "The generated developer access token is stored in ${env_file}."
echo "Run: node /opt/dp-beget-bridge/scripts/doctor.mjs"
