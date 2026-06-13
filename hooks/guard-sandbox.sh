#!/usr/bin/env bash
# forge guard: sandbox-boundary check (SessionStart)  --  ADR 0016 / brief 002
#
# Purpose: when a product repo commits `.forge.json` with {"sandbox":"required"},
# a forge session is expected to run inside an approved boundary (Docker Sandboxes
# or the hardened fallback devcontainer). Each approved boundary exports
# FORGE_SANDBOX=<docker-sandbox|devcontainer>. This guard checks for that.
#
# DESIGN NOTE -- convention-with-volume, NOT a kernel-level block:
#   Claude Code's SessionStart event cannot abort a session (exit 2 only prints
#   stderr and the session continues). So this guard makes the boundary LOUD, not
#   impossible: a big user-visible warning (systemMessage) plus a strong
#   instruction to the agent (additionalContext) telling it to stop and re-enter
#   the sandbox. A true hard-block would require a UserPromptSubmit/PreToolUse
#   guard -- deliberately out of scope for this iteration (see brief 002).
#
# States:
#   - no .forge.json, or sandbox != required  -> silent pass (HQ/forge-dev repos)
#   - FORGE_SANDBOX set                        -> quiet confirmation, pass
#   - FORGE_SANDBOX_OVERRIDE=1                  -> LOUD override banner, pass
#   - otherwise (on the bare host)             -> LOUD warning + agent stop-order
#
# Robustness: fail-open. A guard that crashes must never break the user's
# session; since it cannot truly block anyway, any internal error => silent pass.

set -u

input="$(cat 2>/dev/null || true)"

# --- locate the project's .forge.json -------------------------------------------------
# Prefer Claude's env var; fall back to the stdin payload's cwd; then PWD.
project_dir="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$project_dir" ] && command -v jq >/dev/null 2>&1; then
  project_dir="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
fi
[ -z "$project_dir" ] && project_dir="$PWD"

forge_json="$project_dir/.forge.json"
[ -f "$forge_json" ] || exit 0   # not a forge product repo -> nothing to enforce

# --- read the sandbox requirement -----------------------------------------------------
sandbox_req=""
if command -v jq >/dev/null 2>&1; then
  sandbox_req="$(jq -r '.sandbox // empty' "$forge_json" 2>/dev/null || true)"
else
  sandbox_req="$(grep -o '"sandbox"[[:space:]]*:[[:space:]]*"[^"]*"' "$forge_json" 2>/dev/null \
                  | head -1 | sed 's/.*:[[:space:]]*"\([^"]*\)".*/\1/' || true)"
fi
[ "$sandbox_req" = "required" ] || exit 0   # requirement not set -> pass

# --- JSON emit helpers ----------------------------------------------------------------
# Messages are kept single-line (no embedded newlines) so the no-jq fallback only
# needs to escape backslashes and double quotes.
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

emit() {  # $1 = systemMessage (user-visible), $2 = additionalContext (agent-visible)
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg sm "$1" --arg ac "$2" \
      '{systemMessage:$sm, hookSpecificOutput:{hookEventName:"SessionStart", additionalContext:$ac}}'
  else
    printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' \
      "$(esc "$1")" "$(esc "$2")"
  fi
}

emit_ctx() {  # $1 = additionalContext only, quiet (no user-visible message)
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg ac "$1" \
      '{suppressOutput:true, hookSpecificOutput:{hookEventName:"SessionStart", additionalContext:$ac}}'
  else
    printf '{"suppressOutput":true,"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' \
      "$(esc "$1")"
  fi
}

# --- decide state ---------------------------------------------------------------------
if [ -n "${FORGE_SANDBOX:-}" ]; then
  emit_ctx "forge sandbox boundary active (FORGE_SANDBOX=${FORGE_SANDBOX}). ADR 0016 enforcement satisfied; the credential-free guarantee is in effect."
  exit 0
fi

if [ "${FORGE_SANDBOX_OVERRIDE:-}" = "1" ]; then
  banner="⚠️  FORGE SANDBOX OVERRIDE ACTIVE — this session is running OUTSIDE the required sandbox boundary (FORGE_SANDBOX_OVERRIDE=1). The credential-free guarantee of ADR 0013/0016 is NOT in effect. Proceed only if you know exactly why."
  ctx="SANDBOX OVERRIDE (forge ADR 0016): this product repo declares sandbox=required and FORGE_SANDBOX is unset, but the session was started with FORGE_SANDBOX_OVERRIDE=1. You are on the bare host. Treat it as credential-bearing: do NOT touch cloud tooling, secrets, kubeconfigs, or anything beyond this repo. Announce the override prominently in your first reply so the user is reminded the boundary is bypassed."
  emit "$banner" "$ctx"
  exit 0
fi

# blocked state (loud, but not a true abort -- see DESIGN NOTE)
warn="🚫 forge: this repo requires a sandbox (.forge.json sandbox=required, ADR 0016) but FORGE_SANDBOX is unset — you are on the bare host. Start the session inside an approved boundary (Docker Sandboxes or the fallback devcontainer; see SANDBOX.md). To bypass intentionally and loudly, set FORGE_SANDBOX_OVERRIDE=1."
ctx="SANDBOX GUARD (forge ADR 0016): this product repo declares sandbox=required, but FORGE_SANDBOX is not set, so this session is running on the UNSANDBOXED host. You MUST NOT proceed with implementation work here. Stop and tell the user to restart the session inside an approved boundary (Docker Sandboxes or the hardened fallback devcontainer — see SANDBOX.md), which sets FORGE_SANDBOX. The only sanctioned bypass is FORGE_SANDBOX_OVERRIDE=1, which is loud and discouraged. Do not silently continue."
emit "$warn" "$ctx"
exit 0
