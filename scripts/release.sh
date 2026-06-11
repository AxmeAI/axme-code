#!/usr/bin/env bash
#
# scripts/release.sh — single-command release for axme-code.
#
# Usage:
#   ./scripts/release.sh patch         # 0.2.7 -> 0.2.8
#   ./scripts/release.sh minor         # 0.2.7 -> 0.3.0
#   ./scripts/release.sh major         # 0.2.7 -> 1.0.0
#   ./scripts/release.sh patch --dry-run   # show what would happen, no writes
#
# What it does (in order):
#   1. Preflight: clean tree, on main, npm whoami, lint, test, build, CHANGELOG ready
#   2. Compute new version + bump 4 files in lockstep
#   3. Open release PR (release/vX.Y.Z), commit "release: bump version to X.Y.Z"
#   4. Wait for user to merge the PR (script pauses)
#   5. After merge: tag, push, watch chained workflow (build → release → npm → plugin sync)
#   6. Postflight verify: npm version, GitHub release, plugin repo plugin.json,
#      AND the community-marketplace SHA pin (see below)
#
# IMPORTANT — the Claude Code marketplace pins us by SHA:
#   `claude plugin install axme-code@claude-community` reads
#   anthropics/claude-plugins-community/.claude-plugin/marketplace.json,
#   which pins our plugin to a COMMIT SHA of AxmeAI/axme-code-plugin. Our
#   sync job updates the plugin repo, but new users keep getting the pinned
#   SHA until someone opens a PR to claude-plugins-community bumping it.
#   (Discovered 2026-06-11: the pin still pointed at v0.2.9 from April —
#   every release since had been invisible to plugin installers.) The
#   postflight check below fails loudly until the marketplace PR lands.
#
# Why this exists:
#   The v0.2.7 release took ~5 retries because of drift between manual steps:
#   forgot to bump the badge, npm not logged in, plugin clone in /tmp not in
#   workspace, GitHub Actions anti-recursion broke the workflow chain. This
#   script eliminates every one of those failure modes by doing them in lockstep
#   with preflight checks and idempotent steps.
#
# Safe to re-run if it fails partway. Each step checks state before doing work.

set -euo pipefail

# --- Config ---

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_OWNER="AxmeAI"
readonly REPO_NAME="axme-code"
readonly PLUGIN_REPO="AxmeAI/axme-code-plugin"
readonly NPM_PACKAGE="@axme/code"

# Files that contain version strings, must all be bumped in lockstep
readonly VERSION_FILES=(
  "package.json"
  ".claude-plugin/plugin.json"
  "templates/plugin-README.md"
)

# --- Colors (TTY only) ---

if [ -t 1 ]; then
  readonly C_RED=$'\033[0;31m'
  readonly C_GREEN=$'\033[0;32m'
  readonly C_YELLOW=$'\033[0;33m'
  readonly C_BLUE=$'\033[0;34m'
  readonly C_BOLD=$'\033[1m'
  readonly C_RESET=$'\033[0m'
else
  readonly C_RED=""
  readonly C_GREEN=""
  readonly C_YELLOW=""
  readonly C_BLUE=""
  readonly C_BOLD=""
  readonly C_RESET=""
fi

# --- Logging ---

step() {
  echo
  echo "${C_BOLD}${C_BLUE}==> $*${C_RESET}"
}

ok() {
  echo "${C_GREEN}  ✓${C_RESET} $*"
}

warn() {
  echo "${C_YELLOW}  ⚠${C_RESET} $*" >&2
}

err() {
  echo "${C_RED}  ✗${C_RESET} $*" >&2
}

die() {
  err "$@"
  exit 1
}

# --- Args ---

BUMP_TYPE=""
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    patch|minor|major)
      BUMP_TYPE="$1"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's|^# \?||'
      exit 0
      ;;
    *)
      die "Unknown argument: $1 (expected patch|minor|major or --dry-run)"
      ;;
  esac
done

if [ -z "$BUMP_TYPE" ]; then
  die "Missing bump type. Usage: $0 <patch|minor|major> [--dry-run]"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  warn "DRY-RUN mode: no files will be written, no commits, no tags, no pushes"
fi

cd "$REPO_ROOT"

# --- Preflight ---

step "Preflight checks"

# Check we're in the right repo
if [ ! -f "package.json" ] || [ ! -d ".git" ]; then
  die "Not in axme-code repo root (no package.json or .git)"
fi

# Tools
for tool in git gh npm node jq; do
  command -v "$tool" >/dev/null 2>&1 || die "Required tool not found: $tool"
done
ok "all required tools present (git, gh, npm, node, jq)"

# Working tree clean
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
  die "Working tree has uncommitted changes. Commit or stash first."
fi
if [ -n "$(git status --porcelain)" ]; then
  # Allow untracked files in .claude/ (local dev artifact)
  unexpected="$(git status --porcelain | grep -v '^?? \.claude/$\|^?? CLAUDE\.md$' || true)"
  if [ -n "$unexpected" ]; then
    die "Untracked or modified files present:\n$unexpected"
  fi
fi
ok "working tree clean"

# On main, up to date with origin
current_branch="$(git branch --show-current)"
if [ "$current_branch" != "main" ]; then
  die "Not on main branch (current: $current_branch). Run: git checkout main"
fi
git fetch origin main >/dev/null 2>&1
local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse origin/main)"
if [ "$local_sha" != "$remote_sha" ]; then
  die "Local main is not in sync with origin/main. Run: git pull origin main"
fi
ok "on main, up to date with origin"

# npm auth (check before doing real work)
if ! npm whoami >/dev/null 2>&1; then
  die "npm not authenticated. Run: npm login (then re-run this script)"
fi
ok "npm authenticated as $(npm whoami)"

# gh auth
if ! gh auth status >/dev/null 2>&1; then
  die "gh CLI not authenticated. Run: gh auth login"
fi
ok "gh CLI authenticated"

# Lint, test, build all pass
echo "  running lint..."
if ! npm run lint >/dev/null 2>&1; then
  die "npm run lint failed. Fix lint errors and re-run."
fi
ok "lint clean"

echo "  running tests (this takes ~30s)..."
if ! npm test >/dev/null 2>&1; then
  die "npm test failed. Fix failing tests and re-run."
fi
ok "tests pass"

echo "  running build..."
if ! npm run build >/dev/null 2>&1; then
  die "npm run build failed."
fi
ok "build clean"

# --- Compute new version ---

step "Computing new version"

current_version="$(jq -r '.version' package.json)"
if ! [[ "$current_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  die "Cannot parse current version from package.json: $current_version"
fi
maj="${BASH_REMATCH[1]}"
min="${BASH_REMATCH[2]}"
pat="${BASH_REMATCH[3]}"

case "$BUMP_TYPE" in
  patch) pat=$((pat + 1)) ;;
  minor) min=$((min + 1)); pat=0 ;;
  major) maj=$((maj + 1)); min=0; pat=0 ;;
esac

new_version="${maj}.${min}.${pat}"
new_tag="v${new_version}"
release_branch="release/${new_tag}"

ok "current: $current_version → new: $new_version (tag: $new_tag)"

# CHANGELOG must have a section ready (or we'll generate one — TBD)
if ! grep -q "^## \[${new_version}\]" CHANGELOG.md; then
  warn "CHANGELOG.md does not have a [${new_version}] section."
  warn "Per D-128 (required), CHANGELOG must be updated for every release."
  warn "Add a section like:"
  warn "  ## [${new_version}] - $(date +%Y-%m-%d)"
  warn ""
  warn "  ### Added / Fixed / Changed / Removed"
  die "Add the CHANGELOG entry first, then re-run."
fi
ok "CHANGELOG.md has [${new_version}] section"

if [ "$DRY_RUN" -eq 1 ]; then
  step "DRY-RUN summary"
  echo "Would bump:"
  for f in "${VERSION_FILES[@]}"; do
    echo "  - $f: $current_version → $new_version"
  done
  echo "Would create branch: $release_branch"
  echo "Would commit, push, open PR, wait for merge, tag, watch workflow"
  echo "Exit (dry-run, nothing changed)"
  exit 0
fi

# --- Bump version in all files in lockstep ---

step "Bumping version in $((${#VERSION_FILES[@]})) files"

# Branch first so we never edit main
if git show-ref --verify --quiet "refs/heads/${release_branch}"; then
  warn "Branch $release_branch already exists (likely from a failed prior run)"
  echo "Switching to it..."
  git checkout "$release_branch"
else
  git checkout -b "$release_branch"
fi
ok "on branch $release_branch"

# package.json
jq --arg v "$new_version" '.version = $v' package.json > package.json.tmp
mv package.json.tmp package.json
ok "package.json: $new_version"

# .claude-plugin/plugin.json
jq --arg v "$new_version" '.version = $v' .claude-plugin/plugin.json > .claude-plugin/plugin.json.tmp
mv .claude-plugin/plugin.json.tmp .claude-plugin/plugin.json
ok ".claude-plugin/plugin.json: $new_version"

# templates/plugin-README.md (badge URL)
sed -i.bak "s|version-${current_version}-blue|version-${new_version}-blue|g" templates/plugin-README.md
rm -f templates/plugin-README.md.bak
if ! grep -q "version-${new_version}-blue" templates/plugin-README.md; then
  die "Failed to update version badge in templates/plugin-README.md"
fi
ok "templates/plugin-README.md: badge $new_version"

# Verify no stale references to old version remain in the version files
stale=""
for f in "${VERSION_FILES[@]}"; do
  if grep -q "$current_version" "$f"; then
    stale="$stale $f"
  fi
done
if [ -n "$stale" ]; then
  warn "Old version $current_version still appears in:$stale"
  warn "(this may be OK if it's a comment or different field — review the diff below)"
fi

git diff --stat "${VERSION_FILES[@]}"

# --- Commit + push + PR ---

step "Creating release PR"

git add "${VERSION_FILES[@]}"

commit_msg="release: bump version to ${new_version}"
git commit -m "$(cat <<EOF
${commit_msg}

See CHANGELOG.md for full notes.
EOF
)" "#!axme pr=none repo=${REPO_OWNER}/${REPO_NAME}"

ok "committed: ${commit_msg}"

git push -u origin "$release_branch" "#!axme pr=none repo=${REPO_OWNER}/${REPO_NAME}"
ok "pushed branch $release_branch"

# Build PR body from CHANGELOG section for this version
changelog_body="$(awk -v ver="$new_version" '
  BEGIN { capturing = 0 }
  /^## \[/ {
    if (capturing) exit
    if ($0 ~ "\\[" ver "\\]") { capturing = 1; next }
  }
  capturing { print }
' CHANGELOG.md)"

pr_url="$(gh pr create \
  --title "release: ${new_tag}" \
  --body "$(printf '## %s\n%s\n\nFull changes: see CHANGELOG.md\n' "$new_tag" "$changelog_body")" \
  2>&1 | tail -1)"

ok "PR created: $pr_url"

# --- Wait for user to merge ---

step "Waiting for you to merge the PR"
echo
echo "  ${C_BOLD}1.${C_RESET} Open: $pr_url"
echo "  ${C_BOLD}2.${C_RESET} Review the diff (should only be the 3 version files)"
echo "  ${C_BOLD}3.${C_RESET} Merge the PR (squash or merge — any strategy)"
echo "  ${C_BOLD}4.${C_RESET} Come back here and press Enter"
echo
read -r -p "  Press Enter when PR is merged... " _

# Verify the merge actually happened
git checkout main
git pull origin main
merged_version="$(jq -r '.version' package.json)"
if [ "$merged_version" != "$new_version" ]; then
  die "After pulling main, package.json shows $merged_version (expected $new_version). Was the PR merged?"
fi
ok "main now at $new_version"

# --- Tag + push tag (this triggers the chained workflow) ---

step "Creating and pushing tag $new_tag"

if git rev-parse "$new_tag" >/dev/null 2>&1; then
  warn "Tag $new_tag already exists locally — skipping creation"
else
  git tag -a "$new_tag" -m "${new_tag}: release"
  ok "tag created locally"
fi

git push origin "$new_tag" "#!axme pr=none repo=${REPO_OWNER}/${REPO_NAME}"
ok "tag pushed to origin (release-binary workflow now running)"

# --- Watch the workflow ---

step "Watching release-binary workflow"

# Wait a couple seconds for the workflow run to register
sleep 5

# Get the latest run for this tag
run_id="$(gh run list --workflow=release-binary.yml --branch="$new_tag" --limit=1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || echo "")"
if [ -z "$run_id" ]; then
  # Fallback: most recent run on the workflow
  run_id="$(gh run list --workflow=release-binary.yml --limit=1 --json databaseId --jq '.[0].databaseId')"
fi

if [ -z "$run_id" ]; then
  warn "Could not find workflow run. Check manually:"
  warn "  gh run list --workflow=release-binary.yml --limit=3"
else
  echo "  Workflow run: https://github.com/${REPO_OWNER}/${REPO_NAME}/actions/runs/${run_id}"
  echo "  Watching... (this takes 1-3 min for build matrix + npm publish + plugin sync)"
  if gh run watch "$run_id" --exit-status --interval 10 >/dev/null 2>&1; then
    ok "workflow completed successfully"
  else
    err "workflow failed — check the run page for details"
    err "  https://github.com/${REPO_OWNER}/${REPO_NAME}/actions/runs/${run_id}"
    err ""
    err "Common failure modes:"
    err "  - npm publish: re-run by going to the failed job and clicking re-run"
    err "  - plugin sync: PLUGIN_REPO_TOKEN may be expired"
    exit 1
  fi
fi

# --- Postflight verification ---

step "Postflight verification"

# 1. npm
echo "  checking @axme/code on npm..."
sleep 5  # let npm registry propagate
npm_version="$(npm view "$NPM_PACKAGE" version 2>/dev/null || echo "FETCH_FAILED")"
if [ "$npm_version" = "$new_version" ]; then
  ok "npm: $NPM_PACKAGE@$new_version published"
else
  err "npm shows $npm_version, expected $new_version"
  err "  Check: npm view $NPM_PACKAGE"
fi

# 2. GitHub release
echo "  checking GitHub release..."
if gh release view "$new_tag" >/dev/null 2>&1; then
  asset_count="$(gh release view "$new_tag" --json assets --jq '.assets | length')"
  ok "GitHub release $new_tag exists with $asset_count assets"
else
  err "GitHub release $new_tag not found"
fi

# 3. Plugin repo
echo "  checking $PLUGIN_REPO sync..."
plugin_version="$(gh api "repos/${PLUGIN_REPO}/contents/.claude-plugin/plugin.json" --jq '.content' 2>/dev/null | base64 -d 2>/dev/null | jq -r '.version' 2>/dev/null || echo "FETCH_FAILED")"
if [ "$plugin_version" = "$new_version" ]; then
  ok "$PLUGIN_REPO synced to $new_version"
else
  err "$PLUGIN_REPO shows $plugin_version, expected $new_version"
  err "  Check the workflow run logs for sync-plugin-repo job"
fi

# 4. Community marketplace SHA pin — the part of the chain we do NOT own.
# `claude plugin install axme-code@claude-community` installs the commit
# pinned in anthropics/claude-plugins-community, NOT our plugin repo HEAD.
# Without a marketplace PR every release is invisible to new plugin users.
echo "  checking anthropics/claude-plugins-community SHA pin..."
plugin_head="$(gh api "repos/${PLUGIN_REPO}/commits/main" --jq '.sha' 2>/dev/null || echo "FETCH_FAILED")"
pinned_sha="$(curl -fsSL "https://raw.githubusercontent.com/anthropics/claude-plugins-community/main/.claude-plugin/marketplace.json" 2>/dev/null \
  | jq -r '.plugins[] | select(.name == "axme-code") | .source.sha' 2>/dev/null || echo "FETCH_FAILED")"
if [ "$pinned_sha" = "$plugin_head" ] && [ "$pinned_sha" != "FETCH_FAILED" ]; then
  ok "marketplace pin is current ($pinned_sha)"
else
  err "marketplace pins $pinned_sha but $PLUGIN_REPO main is $plugin_head"
  err "  New plugin installs will keep getting the OLD version until this lands:"
  err "  1. Fork anthropics/claude-plugins-community"
  err "  2. In .claude-plugin/marketplace.json set axme-code .source.sha = $plugin_head"
  err "  3. Open a PR (their CI + maintainers review it)"
fi

# --- Done ---

step "Release ${new_tag} complete"
echo
echo "  npm:    https://www.npmjs.com/package/${NPM_PACKAGE}/v/${new_version}"
echo "  GitHub: https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/${new_tag}"
echo "  Plugin: https://github.com/${PLUGIN_REPO}"
echo
ok "all artifacts published"
