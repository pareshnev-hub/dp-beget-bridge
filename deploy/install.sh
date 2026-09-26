#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run with sudo: sudo ./deploy/install.sh --domain bridge.example.com --user <non-root-user>" >&2
  exit 1
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source_dir=$(cd -- "${script_dir}/.." && pwd)
source "${script_dir}/lib/install-code.sh"
domain=""
work_user=${SUDO_USER:-}
allowed_root=""
telemetry="false"
live_session_policy="preserve"
agent_user="dp-agent"
mcp_user="dp-mcp"
ipc_group="dp-bridge-work"
config_dir=${DP_INSTALL_CONFIG_DIR:-/etc/dp-beget-bridge}
session_data_dir=/var/lib/dp-beget-bridge
session_host_unit=dp-beget-session-host.service
agent_unit=dp-beget-agent.service
mcp_unit=dp-beget-mcp.service
oauth_unit=dp-beget-mcp-oauth-spike.service
tunnel_unit=dp-beget-tunnel.service
api_services_stopped=false
session_host_stopped=false
tunnel_was_active=false
oauth_was_active=false

restore_services_on_error() {
  local status=$?
  trap - EXIT
  if [[ ${status} -ne 0 && ${api_services_stopped} == "true" ]]; then
    echo "Installation failed; restoring local services without changing public exposure." >&2
    if [[ ${session_host_stopped} == "true" ]]; then
      systemctl start "${session_host_unit}" 2>/dev/null || true
    fi
    systemctl restart "${agent_unit}" "${mcp_unit}" 2>/dev/null || true
    if [[ ${oauth_was_active} == "true" ]]; then
      systemctl start "${oauth_unit}" 2>/dev/null || true
    fi
    if [[ ${tunnel_was_active} == "true" ]]; then
      systemctl start "${tunnel_unit}" 2>/dev/null || true
    fi
  fi
  exit "${status}"
}
trap restore_services_on_error EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) domain=${2:-}; shift 2 ;;
    --user|--work-user) work_user=${2:-}; shift 2 ;;
    --allowed-root) allowed_root=${2:-}; shift 2 ;;
    --telemetry) telemetry=${2:-}; shift 2 ;;
    --live-session-policy) live_session_policy=${2:-}; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z ${domain} ]]; then
  echo "--domain is required and must already point to this VPS" >&2
  exit 1
fi
if [[ -z ${work_user} ]]; then
  echo "A non-root work user is required. Pass --user <existing-non-root-user>." >&2
  exit 1
fi
if ! id "${work_user}" >/dev/null 2>&1; then
  echo "User does not exist: ${work_user}" >&2
  exit 1
fi
if [[ $(id -u "${work_user}") -eq 0 ]]; then
  echo "Refusing to run Agent, MCP, or terminal sessions as root. Pass --user <existing-non-root-user>." >&2
  exit 1
fi
work_group=$(id -gn "${work_user}")
if [[ -z ${allowed_root} ]]; then
  allowed_root=$(getent passwd "${work_user}" | cut -d: -f6)
fi
if [[ ! -d ${allowed_root} ]]; then
  echo "Allowed root does not exist: ${allowed_root}" >&2
  exit 1
fi
if [[ ${telemetry} != "true" && ${telemetry} != "false" ]]; then
  echo "--telemetry must be true or false" >&2
  exit 1
fi
if [[ ${live_session_policy} != "preserve" ]]; then
  echo "Only --live-session-policy preserve is supported; live sessions are never stopped implicitly." >&2
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

env_value() {
  local file=$1 key=$2
  [[ -f ${file} ]] || return 0
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "${file}"
}

legacy_env=${config_dir}/bridge.env
agent_env=${config_dir}/agent.env
mcp_env=${config_dir}/mcp.env
oauth_env=${config_dir}/mcp-oauth-spike.env
session_host_env=${config_dir}/session-host.env
legacy_migration=false
legacy_tmux_socket=""
if [[ -f ${legacy_env} && ! -f ${agent_env} ]]; then
  legacy_migration=true
  legacy_tmux_socket=$(env_value "${legacy_env}" DP_TMUX_SOCKET)
  [[ -n ${legacy_tmux_socket} ]] || legacy_tmux_socket=/var/lib/dp-beget-bridge/tmux/tmux.sock
  if runuser -u "${work_user}" -- tmux -S "${legacy_tmux_socket}" list-sessions >/dev/null 2>&1; then
    echo "Legacy migration stopped: live tmux sessions may still inherit the old shared credential environment." >&2
    echo "Close the live sessions explicitly, then rerun with --live-session-policy preserve." >&2
    exit 1
  fi
fi

if ! getent group "${ipc_group}" >/dev/null; then
  groupadd --system "${ipc_group}"
fi
for identity in "${agent_user}" "${mcp_user}"; do
  if ! getent group "${identity}" >/dev/null; then
    groupadd --system "${identity}"
  fi
  if ! id "${identity}" >/dev/null 2>&1; then
    useradd --system --gid "${identity}" --home-dir "/var/lib/dp-beget-bridge-${identity#dp-}" \
      --no-create-home --shell /usr/sbin/nologin "${identity}"
  fi
  if [[ $(id -u "${identity}") -eq 0 ]]; then
    echo "Refusing invalid root service identity: ${identity}" >&2
    exit 1
  fi
done
usermod -a -G "${ipc_group}" "${agent_user}"
usermod -a -G "${ipc_group}" "${work_user}"

# The restricted workspace is shared only by the policy service and work identity.
chgrp "${ipc_group}" "${allowed_root}"
chmod g+rwx,g+s "${allowed_root}"

# Freeze normal API admission before proving that Session Host has no active
# operation. tmux remains outside the Session Host process lifecycle.
session_host_was_active=false
if systemctl is-active --quiet "${session_host_unit}"; then
  session_host_was_active=true
fi
if systemctl is-active --quiet "${tunnel_unit}"; then
  tunnel_was_active=true
  systemctl stop "${tunnel_unit}"
fi
if systemctl is-active --quiet "${oauth_unit}"; then
  oauth_was_active=true
  systemctl stop "${oauth_unit}"
fi
systemctl stop "${mcp_unit}" "${agent_unit}" 2>/dev/null || true
api_services_stopped=true
if [[ ${session_host_was_active} == "true" ]]; then
  node "${source_dir}/scripts/deploy/session-host-restart-preflight.mjs" "${session_data_dir}/state.sqlite"
  systemctl stop "${session_host_unit}"
  session_host_stopped=true
fi
if [[ ${legacy_migration} == "true" ]]; then
  runuser -u "${work_user}" -- tmux -S "${legacy_tmux_socket}" kill-server 2>/dev/null || true
fi
install_code_tree "${source_dir}" /opt/dp-beget-bridge
cd /opt/dp-beget-bridge
npm ci --omit=dev

install -d -m 0750 -o root -g root "${config_dir}"
install -d -m 0700 -o "${work_user}" -g "${work_group}" "${session_data_dir}"
install -d -m 0700 -o "${agent_user}" -g "${agent_user}" /var/lib/dp-beget-bridge-agent
install -d -m 0700 -o "${mcp_user}" -g "${mcp_user}" /var/lib/dp-beget-bridge-mcp
if [[ -f /var/lib/dp-beget-bridge/installation-id && ! -f /var/lib/dp-beget-bridge-agent/installation-id ]]; then
  install -m 0600 -o "${agent_user}" -g "${agent_user}" \
    /var/lib/dp-beget-bridge/installation-id /var/lib/dp-beget-bridge-agent/installation-id
fi

agent_token=$(env_value "${agent_env}" DP_AGENT_TOKEN)
[[ -n ${agent_token} ]] || agent_token=$(env_value "${legacy_env}" DP_AGENT_TOKEN)
[[ -n ${agent_token} ]] || agent_token=$(openssl rand -hex 32)
agent_oauth_token=$(env_value "${agent_env}" DP_AGENT_OAUTH_TOKEN)
[[ -n ${agent_oauth_token} ]] || agent_oauth_token=$(openssl rand -hex 32)
agent_context_secret=$(env_value "${agent_env}" DP_AGENT_CONTEXT_SECRET)
[[ -n ${agent_context_secret} ]] || agent_context_secret=$(openssl rand -hex 32)
if [[ ${agent_oauth_token} == "${agent_token}" ]]; then
  echo "DP_AGENT_OAUTH_TOKEN must differ from DP_AGENT_TOKEN" >&2
  exit 1
fi
mcp_token=$(env_value "${mcp_env}" DP_MCP_ACCESS_TOKEN)
[[ -n ${mcp_token} ]] || mcp_token=$(env_value "${legacy_env}" DP_MCP_ACCESS_TOKEN)
[[ -n ${mcp_token} ]] || mcp_token=$(openssl rand -hex 32)

{
  printf 'DP_AGENT_HOST=127.0.0.1\n'
  printf 'DP_AGENT_PORT=8787\n'
  printf 'DP_AGENT_TOKEN=%s\n' "${agent_token}"
  printf 'DP_AGENT_OAUTH_TOKEN=%s\n' "${agent_oauth_token}"
  printf 'DP_AGENT_CONTEXT_SECRET=%s\n' "${agent_context_secret}"
  printf 'DP_SESSION_HOST_SOCKET=/run/dp-beget-bridge/session-host.sock\n'
  printf 'DP_DATA_DIR=/var/lib/dp-beget-bridge-agent\n'
  printf 'DP_ALLOWED_ROOTS=%s\n' "${allowed_root}"
  printf 'DP_FILE_UPLOAD_MAX_BYTES=536870912\n'
  printf 'DP_FILE_TRANSFER_MAX_CONCURRENT=2\n'
  printf 'DP_STORAGE_MIN_FREE_BYTES=268435456\n'
  printf 'DP_TELEMETRY_ENABLED=%s\n' "${telemetry}"
  printf 'DP_LOG_LEVEL=info\n'
} > "${agent_env}"
chmod 0640 "${agent_env}"
chown root:"${agent_user}" "${agent_env}"

{
  printf 'DP_AGENT_URL=http://127.0.0.1:8787\n'
  printf 'DP_AGENT_TOKEN=%s\n' "${agent_token}"
  printf 'DP_MCP_HOST=127.0.0.1\n'
  printf 'DP_MCP_PORT=8788\n'
  printf 'DP_MCP_PATH=/mcp\n'
  printf 'DP_MCP_ACCESS_TOKEN=%s\n' "${mcp_token}"
  printf 'DP_PUBLIC_URL=https://%s\n' "${domain}"
  printf 'DP_ATTACHMENT_FETCH_ENABLED=true\n'
  printf 'DP_ATTACHMENT_FETCH_TIMEOUT_MS=120000\n'
  printf 'DP_ATTACHMENT_MAX_BYTES=67108864\n'
  printf 'DP_ATTACHMENT_MAX_REDIRECTS=5\n'
  printf 'DP_ATTACHMENT_MAX_CONCURRENT=2\n'
  printf 'DP_LOG_LEVEL=info\n'
} > "${mcp_env}"
chmod 0640 "${mcp_env}"
chown root:"${mcp_user}" "${mcp_env}"

{
  printf 'DP_SESSION_HOST_SOCKET=/run/dp-beget-bridge/session-host.sock\n'
  printf 'DP_SESSION_DATA_DIR=/var/lib/dp-beget-bridge\n'
  printf 'DP_ALLOWED_ROOTS=%s\n' "${allowed_root}"
  printf 'DP_TMUX_SOCKET=/var/lib/dp-beget-bridge/tmux/tmux.sock\n'
  printf 'DP_COMMAND_WAIT_MS=10000\n'
  printf 'DP_TERMINAL_HISTORY_LINES=100000\n'
  printf 'DP_TERMINAL_MAX_ACTIVE=8\n'
  printf 'DP_SESSION_OUTPUT_WARN_BYTES=52428800\n'
  printf 'DP_SESSION_OUTPUT_MAX_BYTES=67108864\n'
  printf 'DP_TRANSCRIPT_SEGMENT_BYTES=8388608\n'
  printf 'DP_TRANSCRIPT_TOTAL_MAX_BYTES=2147483648\n'
  printf 'DP_STORAGE_MIN_FREE_BYTES=268435456\n'
  printf 'DP_LOG_LEVEL=info\n'
} > "${session_host_env}"
chmod 0640 "${session_host_env}"
chown root:"${work_group}" "${session_host_env}"

# Retain the legacy file only as a root-readable rollback source.
if [[ -f ${legacy_env} ]]; then
  chmod 0600 "${legacy_env}"
  chown root:root "${legacy_env}"
fi

sed \
  -e "s|__DP_AGENT_USER__|${agent_user}|g" \
  -e "s|__DP_AGENT_GROUP__|${agent_user}|g" \
  -e "s|__DP_IPC_GROUP__|${ipc_group}|g" \
  -e "s|__DP_ALLOWED_ROOT__|${allowed_root}|g" \
  deploy/systemd/dp-beget-agent.service > /etc/systemd/system/dp-beget-agent.service
sed \
  -e "s|__DP_MCP_USER__|${mcp_user}|g" \
  -e "s|__DP_MCP_GROUP__|${mcp_user}|g" \
  deploy/systemd/dp-beget-mcp.service > /etc/systemd/system/dp-beget-mcp.service
sed \
  -e "s|__DP_WORK_USER__|${work_user}|g" \
  -e "s|__DP_WORK_GROUP__|${work_group}|g" \
  -e "s|__DP_IPC_GROUP__|${ipc_group}|g" \
  -e "s|__DP_ALLOWED_ROOT__|${allowed_root}|g" \
  deploy/systemd/dp-beget-session-host.service > /etc/systemd/system/dp-beget-session-host.service

systemctl daemon-reload
systemctl enable "${session_host_unit}" "${agent_unit}" "${mcp_unit}"
systemctl start "${session_host_unit}"
node scripts/deploy/wait-session-host.mjs /run/dp-beget-bridge/session-host.sock 15000
systemctl restart "${agent_unit}" "${mcp_unit}"
if [[ ${oauth_was_active} == "true" ]]; then
  oauth_port=$(env_value "${oauth_env}" DP_MCP_PORT)
  if [[ ! ${oauth_port} =~ ^[0-9]+$ ]]; then
    echo "Retained OAuth spike has an invalid DP_MCP_PORT" >&2
    exit 1
  fi
  systemctl start "${oauth_unit}"
  oauth_ready=false
  for (( attempt=0; attempt<30; attempt+=1 )); do
    if node -e 'fetch(process.argv[1]).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))' \
      "http://127.0.0.1:${oauth_port}/health"; then
      oauth_ready=true
      break
    fi
    sleep 1
  done
  if [[ ${oauth_ready} != "true" ]]; then
    echo "Retained OAuth spike did not become ready after the core update" >&2
    exit 1
  fi
fi

# Do not report a successful install until every local endpoint and identity is ready.
node scripts/doctor.mjs
if [[ ${tunnel_was_active} == "true" ]]; then
  systemctl start "${tunnel_unit}"
  node scripts/deploy/wait-tunnel-ready.mjs 15000
  node scripts/tunnel-doctor.mjs
fi

echo
echo "DP Beget Bridge services are running and health checks passed."
echo "Configure HTTPS reverse proxy ${domain} -> 127.0.0.1:8788 using deploy/Caddyfile.example."
echo "MCP URL: https://${domain}/mcp"
echo "Service credentials are split across ${agent_env} and ${mcp_env}; the work identity cannot read them."
echo "Run: node /opt/dp-beget-bridge/scripts/doctor.mjs"
