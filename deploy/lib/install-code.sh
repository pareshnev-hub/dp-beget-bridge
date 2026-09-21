#!/usr/bin/env bash

install_code_tree() {
  local source_dir=$1
  local target_dir=$2

  install -d -m 0755 -o root -g root "${target_dir}"
  cp -a "${source_dir}/." "${target_dir}/"

  # cp -a source/. also applies the source root mode to an existing target.
  # Reassert a traversable, root-owned application root for unprivileged units.
  chown root:root "${target_dir}"
  chmod 0755 "${target_dir}"
}
