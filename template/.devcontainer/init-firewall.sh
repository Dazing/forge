#!/usr/bin/env bash
# forge fallback-devcontainer egress firewall  --  ADR 0016 / brief 002
#
# Deny-by-default outbound, with an explicit allowlist. This mirrors the Docker
# Sandboxes "Locked Down" policy (the `sbx policy` starter allowlist in SANDBOX.md)
# for the devcontainer fallback. Adding a new endpoint is a deliberate, reviewable
# one-line edit to ALLOWED_DOMAINS or ALLOW_GITHUB_META below.
#
# Requires NET_ADMIN/NET_RAW (granted via runArgs in devcontainer.json) and runs as
# root (invoked with sudo from postStartCommand). iptables rules do not persist
# across container restarts, so this runs on every start.
set -euo pipefail

# ---- THE ALLOWLIST (edit deliberately, one line at a time, in review) ---------------
ALLOWED_DOMAINS=(
  # Anthropic API + telemetry
  "api.anthropic.com"
  "statsig.anthropic.com"
  "statsig.com"
  "sentry.io"
  # Package registries
  "registry.npmjs.org"
  "api.nuget.org"
  # GitHub (host endpoints; org git CIDR ranges added from api.github.com/meta below)
  "github.com"
  "api.github.com"
  "codeload.github.com"
  "objects.githubusercontent.com"
  "raw.githubusercontent.com"
)
ALLOW_GITHUB_META=true   # pull GitHub's published web/api/git CIDR ranges and allow them

echo "forge-firewall: applying deny-by-default egress allowlist..."

# ---- reset -------------------------------------------------------------------------
iptables -F
iptables -X
iptables -t nat -F 2>/dev/null || true
iptables -t mangle -F 2>/dev/null || true

# ipset of permitted destination IPs
if command -v ipset >/dev/null 2>&1; then
  ipset destroy forge-allow 2>/dev/null || true
  ipset create forge-allow hash:net
  USE_IPSET=true
else
  echo "forge-firewall: WARNING ipset not found; falling back to per-IP iptables rules."
  USE_IPSET=false
fi

allow_cidr() {  # $1 = ip or cidr
  if [ "$USE_IPSET" = true ]; then
    ipset add forge-allow "$1" 2>/dev/null || true
  else
    iptables -A OUTPUT -d "$1" -j ACCEPT
  fi
}

# ---- baseline allows ---------------------------------------------------------------
# loopback
iptables -A INPUT  -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
# established/related return traffic
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT  -m state --state ESTABLISHED,RELATED -j ACCEPT
# DNS (needed to resolve the allowlist itself)
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

# ---- resolve + allow each domain ---------------------------------------------------
for domain in "${ALLOWED_DOMAINS[@]}"; do
  ips="$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u || true)"
  if [ -z "$ips" ]; then
    echo "forge-firewall: WARNING could not resolve $domain (skipping)"
    continue
  fi
  while read -r ip; do
    [ -n "$ip" ] && allow_cidr "$ip"
  done <<< "$ips"
done

# ---- GitHub published CIDR ranges --------------------------------------------------
if [ "$ALLOW_GITHUB_META" = true ]; then
  meta="$(curl -fsS --max-time 10 https://api.github.com/meta 2>/dev/null || true)"
  if [ -n "$meta" ]; then
    ranges="$(printf '%s' "$meta" \
      | (jq -r '(.web // []) + (.api // []) + (.git // []) | .[]' 2>/dev/null \
         || grep -oE '"[0-9.]+/[0-9]+"' | tr -d '"'))"
    while read -r cidr; do
      [ -n "$cidr" ] && allow_cidr "$cidr"
    done <<< "$ranges"
    echo "forge-firewall: added GitHub meta CIDR ranges."
  else
    echo "forge-firewall: WARNING could not fetch api.github.com/meta (host domains still allowed)."
  fi
fi

# ---- enforce: accept the allowlist, drop everything else ---------------------------
if [ "$USE_IPSET" = true ]; then
  iptables -A OUTPUT -m set --match-set forge-allow dst -j ACCEPT
fi
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

echo "forge-firewall: egress locked down (allowlist active)."

# ---- self-verify (best effort) -----------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 5 https://api.github.com/zen >/dev/null 2>&1; then
    echo "forge-firewall: verify OK — api.github.com reachable."
  else
    echo "forge-firewall: verify WARNING — api.github.com not reachable (DNS/timing?)."
  fi
  if curl -fsS --max-time 5 https://example.com >/dev/null 2>&1; then
    echo "forge-firewall: verify WARNING — example.com reachable; allowlist may be too open!"
  else
    echo "forge-firewall: verify OK — non-allowlisted host (example.com) blocked."
  fi
fi
