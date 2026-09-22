#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run as root: ./deploy/remove-tunnel-harness.sh" >&2
  exit 1
fi

config_dir=/etc/dp-beget-tunnel
install_root=/opt/dp-beget-tunnel
service_unit=dp-beget-tunnel.service

systemctl disable --now "${service_unit}" 2>/dev/null || true
if [[ -f /etc/systemd/system/${service_unit} ]]; then
  rm -f -- "/etc/systemd/system/${service_unit}"
  systemctl daemon-reload
fi
if [[ -d ${config_dir} ]]; then
  rm -rf -- "${config_dir}"
fi
if [[ -d ${install_root} ]]; then
  rm -rf -- "${install_root}"
fi

echo "Local DP-017 tunnel harness removed. Revoke its runtime key and delete or disassociate the Platform tunnel separately."
