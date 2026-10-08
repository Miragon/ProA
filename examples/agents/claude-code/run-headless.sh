#!/usr/bin/env bash
# Works the ProA analysis pipeline with Claude Code in headless mode: one fresh
# `claude -p "/proa:relations <project> <batch-size>"` per batch, so every
# batch starts with a clean context, until GET /api/v1/analyses/pending reports
# no claimable task, a batch fails or makes no progress, or max-batches is reached.
# Every batch runs in an empty temporary directory outside the checkout, with
# ProA's MCP server as its only tools and the plugin from this checkout, and
# writes its JSON result to the log directory. See README.md next to this file.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: run-headless.sh [--allow-api-billing] <project> <model> [batch-size] [max-batches]

  project      project key or prj_ id (the project of the agent token)
  model        exact model id, e.g. claude-opus-5-5 (the agent declares it as llmModel)
  batch-size   tasks per claude -p run, 1-100 (default 5)
  max-batches  at most this many runs (default 20)

Environment:
  PROA_TOKEN           the run's agent token (proa_at_…), required
  PROA_URL             ProA origin (default http://127.0.0.1:7400)
  PROA_LOG_DIR         where the JSON results go; must not hold batch-*.json from an
                       earlier run (default: a new directory under $TMPDIR)
  PROA_MAX_BUDGET_USD  optional spending cap per batch (claude --max-budget-usd)

claude -p uses ANTHROPIC_API_KEY whenever it is set, ahead of your Claude
subscription login. The script refuses to run with it set unless you pass
--allow-api-billing.
EOF
}

die() {
  printf 'run-headless: %s\n' "$*" >&2
  exit 2
}

allow_api_billing=false
case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
  --allow-api-billing)
    allow_api_billing=true
    shift
    ;;
esac
if [[ $# -lt 2 || $# -gt 4 ]]; then
  usage >&2
  exit 2
fi
project=$1
model=$2
batch_size=${3:-5}
max_batches=${4:-20}

[[ $project =~ ^[A-Za-z0-9_-]{1,64}$ ]] || die "project must be a project key or prj_ id: $project"
[[ $model =~ ^[A-Za-z0-9._-]+$ ]] || die "model must be a model id such as claude-opus-5-5: $model"
[[ $batch_size =~ ^([1-9][0-9]?|100)$ ]] || die "batch-size must be a number from 1 to 100: $batch_size"
[[ $max_batches =~ ^[1-9][0-9]*$ ]] || die "max-batches must be a positive number: $max_batches"
budget=${PROA_MAX_BUDGET_USD:-}
[[ -z $budget || $budget =~ ^[0-9]+([.][0-9]+)?$ ]] || die "PROA_MAX_BUDGET_USD must be a number: $budget"
[[ -n ${PROA_TOKEN:-} ]] || die "set PROA_TOKEN to the run's agent token (proa_at_…)"
if [[ -n ${ANTHROPIC_API_KEY:-} && $allow_api_billing != true ]]; then
  die "ANTHROPIC_API_KEY is set, so claude -p would bill the API instead of your Claude subscription; unset it, or pass --allow-api-billing"
fi
for cmd in claude curl node; do
  command -v "$cmd" >/dev/null || die "$cmd not found on PATH"
done

url=${PROA_URL:-http://127.0.0.1:7400}
while [[ $url == */ ]]; do url=${url%/}; done
# mcp.json appends /mcp to ${PROA_URL} as is (//mcp is a 404): claude gets the same origin.
export PROA_URL=$url
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
checkout=$(cd "$here/../../.." && pwd)
plugin_dir=$checkout/plugins/proa
mcp_config=$here/mcp.json
[[ -f $plugin_dir/.claude-plugin/plugin.json ]] || die "plugin not found: $plugin_dir"
tmp=${TMPDIR:-/tmp}
tmp=${tmp%/}

log_dir=${PROA_LOG_DIR:-$(mktemp -d "$tmp/proa-headless-$project-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")}
mkdir -p "$log_dir"
# The batches are numbered from 1 and the cost adds up every batch-*.json here.
if compgen -G "$log_dir/batch-*.json" >/dev/null; then
  die "$log_dir already holds batch results from an earlier run; set PROA_LOG_DIR to a new or empty directory"
fi
# An empty working directory outside the checkout: Claude Code finds no
# CLAUDE.md, .mcp.json or project settings there, and nothing leads to eval/.
workdir=$(mktemp -d "$tmp/proa-agent.XXXXXX")

finish() {
  rm -rf "$workdir"
  if compgen -G "$log_dir/batch-*.json" >/dev/null; then
    # shellcheck disable=SC2016 # JavaScript, not shell
    node -e '
      const fs = require("node:fs");
      const [dir, ...files] = process.argv.slice(1);
      let sum = 0;
      for (const f of files) {
        try { sum += JSON.parse(fs.readFileSync(f, "utf8")).total_cost_usd ?? 0; } catch {}
      }
      console.log(`estimated cost of all batches: ${sum.toFixed(4)} USD; results in ${dir}`);
    ' "$log_dir" "$log_dir"/batch-*.json
  fi
}
trap finish EXIT
case "$workdir/" in
  "$checkout"/*) die "the temporary directory $workdir is inside the checkout; point TMPDIR elsewhere" ;;
esac

# Claimable tasks of the project: queued, or claimed with an expired lease
# (tasks under a live lease do not count). The token goes to curl on stdin,
# not on its command line.
pending() {
  printf 'Authorization: Bearer %s\n' "$PROA_TOKEN" |
    curl -fsS --max-time 30 -H @- "$url/api/v1/analyses/pending?projectId=$project" |
    node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        let total;
        try { total = JSON.parse(s).total; } catch {}
        if (!Number.isInteger(total)) process.exit(1);
        console.log(total);
      });'
}

# One line on a claude -p JSON result; fails unless the result is a success.
summarize() {
  # shellcheck disable=SC2016 # JavaScript, not shell
  node -e '
    const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const cost = typeof r.total_cost_usd === "number" ? r.total_cost_usd.toFixed(4) : "?";
    console.log(`${r.subtype}${r.is_error ? " (error)" : ""}, ${r.num_turns} turns, ~${cost} USD`);
    process.exitCode = r.subtype === "success" && !r.is_error ? 0 : 1;
  ' "$1"
}

unreachable="cannot read the pending tasks from $url (is ProA running, is PROA_TOKEN valid for $project?)"
before=$(pending) || die "$unreachable"
echo "project $project: $before pending; batches of $batch_size with $model; logs in $log_dir"
batch=0
while ((before > 0)); do
  if ((batch >= max_batches)); then
    echo "stopped after $max_batches batches; $before tasks still pending"
    exit 0
  fi
  batch=$((batch + 1))
  log=$log_dir/batch-$(printf '%03d' "$batch").json
  echo "batch $batch: /proa:relations $project $batch_size"
  [[ -d $workdir ]] || die "the temporary directory $workdir disappeared; not starting batch $batch elsewhere"
  status=0
  (
    # set -e does not apply on the left of ||: never fall back to the caller's directory.
    cd "$workdir" || exit 2
    # ProA's tools declare anthropic/maxResultSizeChars, so claim inputs (up to about 80 KB)
    # reach the model inline; the token limit is raised as well for builds that predate it.
    export MAX_MCP_OUTPUT_TOKENS=${MAX_MCP_OUTPUT_TOKENS:-100000}
    claude -p "/proa:relations $project $batch_size" \
      --output-format json \
      --model "$model" \
      --strict-mcp-config --mcp-config "$mcp_config" \
      --plugin-dir "$plugin_dir" \
      --allowedTools 'mcp__proa__*' \
      --tools '' \
      --permission-mode dontAsk \
      --no-session-persistence \
      ${budget:+--max-budget-usd "$budget"}
  ) </dev/null >"$log" || status=$?
  ok=true
  summary=$(summarize "$log" 2>/dev/null) || ok=false
  echo "  ${summary:-no JSON result, see $log}"
  if ((status != 0)); then
    ok=false
    echo "  claude exited with status $status (see $log)" >&2
  fi
  after=$(pending) || die "$unreachable"
  echo "  pending: $before -> $after"
  # A batch that died after claiming leaves its task leased, which also lowers the
  # pending count: only a successful batch counts as progress.
  if [[ $ok != true ]]; then
    echo "stopped: batch $batch failed; see $log" >&2
    echo "  a task it claimed stays leased for up to 15 minutes, and that attempt counts (3 expired leases fail a task); check the run before you start the script again" >&2
    exit 1
  fi
  if ((after >= before)); then
    echo "stopped: batch $batch made no progress (pending $before -> $after); see $log" >&2
    echo "  did the proa MCP server connect (PROA_URL, PROA_TOKEN)?" >&2
    exit 1
  fi
  before=$after
done
echo "done: no task pending in $project after $batch batches"
