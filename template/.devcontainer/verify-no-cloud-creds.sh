#!/usr/bin/env bash
# forge fallback-devcontainer cloud-credential check  --  ADR 0016 / brief 002
#
# The sandbox guarantee (ADR 0013) is "no cloud credentials inside the boundary".
# This check fails LOUDLY at container start if any cloud credential is detectable,
# so a misconfigured mount or leaked env var cannot pass silently. Runs from
# postStartCommand after the firewall; a non-zero exit surfaces in the dev container
# creation/startup log.
set -u

found=0
note() { echo "  ✗ $1"; found=1; }

echo "forge: checking for cloud credentials inside the sandbox..."

# --- credential files / config dirs that must not be present ---------------------
for path in \
  "$HOME/.azure" \
  "$HOME/.aws" \
  "$HOME/.kube" \
  "$HOME/.config/gcloud" \
  "$HOME/.docker/config.json"
do
  [ -e "$path" ] && note "found $path (cloud credential/config must not be mounted)"
done

# --- environment variables that imply cloud credentials --------------------------
# Match common prefixes/names without printing any values.
while IFS='=' read -r name _; do
  case "$name" in
    AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_PROFILE|\
    AZURE_*|ARM_CLIENT_ID|ARM_CLIENT_SECRET|ARM_TENANT_ID|ARM_SUBSCRIPTION_ID|\
    GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|GCLOUD_*|\
    KUBECONFIG|DIGITALOCEAN_*|DO_API_TOKEN)
      note "cloud env var set: $name"
      ;;
  esac
done < <(env)

if [ "$found" -ne 0 ]; then
  echo ""
  echo "############################################################################"
  echo "## forge SANDBOX VIOLATION (ADR 0013/0016): cloud credentials detected!    ##"
  echo "## This boundary must be credential-free. Remove the mount(s)/env var(s)   ##"
  echo "## listed above before working in this container.                          ##"
  echo "############################################################################"
  exit 1
fi

echo "forge: OK — no cloud credentials detected inside the sandbox."
exit 0
