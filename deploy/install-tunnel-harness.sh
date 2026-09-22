#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run as root: ./deploy/install-tunnel-harness.sh --tunnel-id tunnel_..." >&2
  exit 1
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source_dir=$(cd -- "${script_dir}/.." && pwd)
release_file=${script_dir}/tunnel/tunnel-client.release
tunnel_id=""
prompt_runtime_key=false
bridge_config_dir=${DP_INSTALL_CONFIG_DIR:-/etc/dp-beget-bridge}
config_dir=${DP_TUNNEL_CONFIG_DIR:-/etc/dp-beget-tunnel}
install_root=${DP_TUNNEL_INSTALL_ROOT:-/opt/dp-beget-tunnel}
service_user=dp-tunnel
service_unit=dp-beget-tunnel.service
runtime_key_file=${config_dir}/runtime-key
mcp_auth_file=${config_dir}/mcp-authorization
client_config=${config_dir}/tunnel-client.yaml
stage_dir=""

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n ${stage_dir} && ${stage_dir} == /tmp/dp-tunnel-install.* ]]; then
    rm -rf -- "${stage_dir}"
  fi
  exit "${status}"
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tunnel-id) tunnel_id=${2:-}; shift 2 ;;
    --prompt-runtime-key) prompt_runtime_key=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ ! ${tunnel_id} =~ ^tunnel_[0-9a-f]{32}$ ]]; then
  echo "--tunnel-id must match tunnel_ followed by 32 lowercase hexadecimal characters" >&2
  exit 1
fi

for command in curl sha256sum unzip install systemctl awk sed getent groupadd useradd chown chmod node journalctl ss; do
  command -v "${command}" >/dev/null 2>&1 || {
    echo "Missing required command: ${command}" >&2
    exit 1
  }
done

if [[ ! -r ${release_file} ]]; then
  echo "Missing pinned release manifest: ${release_file}" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "${release_file}"
for value in TUNNEL_CLIENT_VERSION TUNNEL_CLIENT_GIT_SHA TUNNEL_CLIENT_ASSET TUNNEL_CLIENT_SHA256 TUNNEL_CLIENT_URL; do
  [[ -n ${!value:-} ]] || { echo "Pinned release field is empty: ${value}" >&2; exit 1; }
done

mcp_env=${bridge_config_dir}/mcp.env
if [[ ! -r ${mcp_env} ]]; then
  echo "MCP configuration is unavailable: ${mcp_env}" >&2
  exit 1
fi
mcp_token=$(awk -F= '$1 == "DP_MCP_ACCESS_TOKEN" { sub(/^[^=]*=/, ""); print; exit }' "${mcp_env}")
if [[ -z ${mcp_token} || ${mcp_token} == *$'\n'* || ${mcp_token} == *$'\r'* ]]; then
  echo "MCP bearer is missing or invalid; refusing to create an unauthenticated local hop" >&2
  exit 1
fi

if ! getent group "${service_user}" >/dev/null; then
  groupadd --system "${service_user}"
fi
if ! id "${service_user}" >/dev/null 2>&1; then
  useradd --system --gid "${service_user}" --home-dir /var/lib/dp-beget-tunnel \
    --no-create-home --shell /usr/sbin/nologin "${service_user}"
fi
if [[ $(id -u "${service_user}") -eq 0 ]]; then
  echo "Refusing invalid root tunnel identity" >&2
  exit 1
fi

install -d -m 0750 -o root -g "${service_user}" "${config_dir}"
if [[ ! -s ${runtime_key_file} ]]; then
  if [[ ${prompt_runtime_key} != true ]]; then
    echo "Runtime API key is absent. Re-run with --prompt-runtime-key and paste it at the hidden prompt." >&2
    exit 1
  fi
  runtime_key=""
  IFS= read -r -s -p "OpenAI tunnel runtime API key: " runtime_key
  printf '\n'
  if [[ -z ${runtime_key} || ${#runtime_key} -gt 4096 || ${runtime_key} == *$'\n'* || ${runtime_key} == *$'\r'* ]]; then
    runtime_key=""
    echo "Runtime API key is empty or invalid" >&2
    exit 1
  fi
  stage_dir=$(mktemp -d /tmp/dp-tunnel-install.XXXXXX)
  umask 077
  printf '%s\n' "${runtime_key}" > "${stage_dir}/runtime-key"
  runtime_key=""
  install -m 0640 -o root -g "${service_user}" "${stage_dir}/runtime-key" "${runtime_key_file}"
else
  chown root:"${service_user}" "${runtime_key_file}"
  chmod 0640 "${runtime_key_file}"
fi

if [[ -z ${stage_dir} ]]; then
  stage_dir=$(mktemp -d /tmp/dp-tunnel-install.XXXXXX)
fi
umask 077
printf 'Bearer %s\n' "${mcp_token}" > "${stage_dir}/mcp-authorization"
mcp_token=""
install -m 0640 -o root -g "${service_user}" "${stage_dir}/mcp-authorization" "${mcp_auth_file}"

archive=${stage_dir}/${TUNNEL_CLIENT_ASSET}
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  "${TUNNEL_CLIENT_URL}" -o "${archive}"
printf '%s  %s\n' "${TUNNEL_CLIENT_SHA256}" "${archive}" | sha256sum --check --status || {
  echo "Pinned tunnel-client checksum verification failed" >&2
  exit 1
}
mkdir "${stage_dir}/archive"
unzip -q "${archive}" -d "${stage_dir}/archive"
binary=${stage_dir}/archive/tunnel-client
[[ -x ${binary} ]] || { echo "Pinned archive does not contain tunnel-client" >&2; exit 1; }
version_output=$(${binary} --version)
[[ ${version_output} == "${TUNNEL_CLIENT_VERSION}+${TUNNEL_CLIENT_GIT_SHA}"* ]] || {
  echo "Pinned tunnel-client version verification failed" >&2
  exit 1
}

version_dir=${install_root}/v${TUNNEL_CLIENT_VERSION}
install -d -m 0755 -o root -g root "${install_root}" "${version_dir}"
install -m 0755 -o root -g root "${binary}" "${version_dir}/tunnel-client"
install -m 0644 -o root -g root "${stage_dir}/archive/LICENSE" "${version_dir}/LICENSE"
install -m 0644 -o root -g root "${stage_dir}/archive/NOTICE" "${version_dir}/NOTICE"
ln -sfn "v${TUNNEL_CLIENT_VERSION}" "${install_root}/current"

sed "s|__TUNNEL_ID__|${tunnel_id}|g" \
  "${script_dir}/tunnel/tunnel-client.yaml.template" > "${stage_dir}/tunnel-client.yaml"
install -m 0640 -o root -g "${service_user}" "${stage_dir}/tunnel-client.yaml" "${client_config}"
install -m 0644 -o root -g root "${script_dir}/systemd/dp-beget-tunnel.service" \
  "/etc/systemd/system/${service_unit}"

"${version_dir}/tunnel-client" doctor --config "${client_config}" --explain
systemctl daemon-reload
systemctl enable "${service_unit}"
systemctl restart "${service_unit}"

ready=false
for _ in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 2 http://127.0.0.1:8790/readyz >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ ${ready} != true ]]; then
  echo "Tunnel service did not become ready; recent redacted service logs follow" >&2
  journalctl -u "${service_unit}" -n 40 --no-pager -o cat >&2 || true
  exit 1
fi

node "${source_dir}/scripts/tunnel-doctor.mjs"
echo "DP-017 private tunnel harness is installed, authenticated, loopback-only, and ready."
