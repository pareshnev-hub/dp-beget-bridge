#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run as root: ./deploy/install-oauth-spike.sh --domain bridge.example.com --prompt-approval-secret" >&2
  exit 1
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
domain=""
port=8789
prompt_approval_secret=false
config_dir=${DP_INSTALL_CONFIG_DIR:-/etc/dp-beget-bridge}
install_root=${DP_BRIDGE_INSTALL_ROOT:-/opt/dp-beget-bridge}
service_user=dp-mcp
service_unit=dp-beget-mcp-oauth-spike.service
oauth_env=${config_dir}/mcp-oauth-spike.env
base_mcp_env=${config_dir}/mcp.env

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) domain=${2:-}; shift 2 ;;
    --port) port=${2:-}; shift 2 ;;
    --prompt-approval-secret) prompt_approval_secret=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ ! ${domain} =~ ^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$ || ${domain} != *.* ]]; then
  echo "--domain must be a hostname already pointed at this VPS" >&2
  exit 1
fi
if [[ ! ${port} =~ ^[0-9]+$ ]] || (( port < 1024 || port > 65535 || port == 8787 || port == 8788 || port == 8790 )); then
  echo "--port must be an unused non-privileged port other than 8787, 8788, or 8790" >&2
  exit 1
fi
for command in node curl install systemctl awk ss sed chmod chown mktemp journalctl seq sleep; do
  command -v "${command}" >/dev/null 2>&1 || { echo "Missing required command: ${command}" >&2; exit 1; }
done
[[ -f ${install_root}/packages/auth/src/oauth-spike.js ]] || {
  echo "Installed bridge revision does not contain DP-012 OAuth support" >&2
  exit 1
}
[[ -r ${base_mcp_env} ]] || { echo "Base MCP configuration is unavailable: ${base_mcp_env}" >&2; exit 1; }
id "${service_user}" >/dev/null 2>&1 || { echo "Missing service identity: ${service_user}" >&2; exit 1; }

env_value() {
  local file=$1 key=$2
  [[ -f ${file} ]] || return 0
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "${file}"
}

agent_token=$(env_value "${base_mcp_env}" DP_AGENT_TOKEN)
[[ ${#agent_token} -ge 32 ]] || { echo "Base MCP Agent credential is missing or invalid" >&2; exit 1; }
approval_secret=$(env_value "${oauth_env}" DP_OAUTH_STAGING_APPROVAL_SECRET)
if [[ -z ${approval_secret} ]]; then
  if [[ ${prompt_approval_secret} != true ]]; then
    echo "Approval secret is absent. Re-run with --prompt-approval-secret." >&2
    exit 1
  fi
  IFS= read -r -s -p "OAuth staging approval secret (32+ characters): " approval_secret
  printf '\n'
  IFS= read -r -s -p "Confirm OAuth staging approval secret: " approval_secret_confirm
  printf '\n'
  if [[ ${approval_secret} != "${approval_secret_confirm}" ]]; then
    approval_secret=""
    approval_secret_confirm=""
    agent_token=""
    echo "Approval secrets do not match" >&2
    exit 1
  fi
  approval_secret_confirm=""
fi
if [[ ${#approval_secret} -lt 32 || ${approval_secret} == *$'\n'* || ${approval_secret} == *$'\r'* ]]; then
  approval_secret=""
  agent_token=""
  echo "Approval secret must contain at least 32 characters and one line" >&2
  exit 1
fi

install -d -m 0750 -o root -g "${service_user}" "${config_dir}"
umask 077
stage_env=$(mktemp /tmp/dp-oauth-spike-env.XXXXXX)
cleanup() {
  local status=$?
  trap - EXIT
  approval_secret=""
  approval_secret_confirm=""
  agent_token=""
  if [[ -n ${stage_env:-} && ${stage_env} == /tmp/dp-oauth-spike-env.* ]]; then rm -f -- "${stage_env}"; fi
  exit "${status}"
}
trap cleanup EXIT

{
  printf 'DP_AGENT_URL=http://127.0.0.1:8787\n'
  printf 'DP_AGENT_TOKEN=%s\n' "${agent_token}"
  printf 'DP_MCP_HOST=127.0.0.1\n'
  printf 'DP_MCP_PORT=%s\n' "${port}"
  printf 'DP_MCP_PATH=/mcp\n'
  printf 'DP_MCP_AUTH_MODE=oauth\n'
  printf 'DP_PUBLIC_URL=https://%s\n' "${domain}"
  printf 'DP_OAUTH_ISSUER=https://%s\n' "${domain}"
  printf 'DP_OAUTH_RESOURCE=https://%s/mcp\n' "${domain}"
  printf 'DP_OAUTH_STAGING_APPROVAL_SECRET=%s\n' "${approval_secret}"
  printf 'DP_OAUTH_SCOPES=files:read\n'
  printf 'DP_OAUTH_ALLOWED_CLIENT_IDS=https://chatgpt.com/oauth/client.json\n'
  printf 'DP_OAUTH_TRANSACTION_TTL_MS=300000\n'
  printf 'DP_OAUTH_CODE_TTL_MS=120000\n'
  printf 'DP_OAUTH_ACCESS_TOKEN_TTL_MS=600000\n'
  printf 'DP_OAUTH_CLIENT_METADATA_TIMEOUT_MS=5000\n'
  printf 'DP_ATTACHMENT_FETCH_ENABLED=false\n'
  printf 'DP_LOG_LEVEL=info\n'
} > "${stage_env}"
install -m 0640 -o root -g "${service_user}" "${stage_env}" "${oauth_env}"
agent_token=""
approval_secret=""

sed \
  -e "s|__DP_MCP_USER__|${service_user}|g" \
  -e "s|__DP_MCP_GROUP__|${service_user}|g" \
  "${install_root}/deploy/systemd/dp-beget-mcp-oauth-spike.service" > "/etc/systemd/system/${service_unit}"
chmod 0644 "/etc/systemd/system/${service_unit}"
chown root:root "/etc/systemd/system/${service_unit}"

systemctl daemon-reload
systemctl enable "${service_unit}"
systemctl restart "${service_unit}"

ready=false
for _ in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ ${ready} != true ]]; then
  echo "OAuth spike service did not become ready" >&2
  journalctl -u "${service_unit}" -n 40 --no-pager -o cat >&2 || true
  exit 1
fi

metadata=$(curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:${port}/.well-known/oauth-protected-resource")
node -e '
  const value = JSON.parse(process.argv[1]);
  const expected = process.argv[2];
  if (value.resource !== `${expected}/mcp`) process.exit(1);
  if (!Array.isArray(value.authorization_servers) || value.authorization_servers[0] !== expected) process.exit(1);
' "${metadata}" "https://${domain}" || { echo "Protected resource metadata validation failed" >&2; exit 1; }

ss -ltn | awk -v port=":${port}" '$4 ~ port "$" { print; found=1; if ($4 !~ /127\.0\.0\.1:/) bad=1 } END { exit(!found || bad) }' || {
  echo "OAuth spike listener is missing or not loopback-only" >&2
  exit 1
}

echo "DP-012 OAuth spike is healthy on 127.0.0.1:${port}."
echo "Configure HTTPS reverse proxy https://${domain} -> 127.0.0.1:${port}; do not expose the port directly."
echo "MCP URL: https://${domain}/mcp"
