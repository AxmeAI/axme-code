#!/usr/bin/env bash
# Script to record AXME Code demo as asciinema cast
# Usage: ./record-demo.sh
# Output: docs/demo/demo.cast → docs/demo.svg
#
# This script simulates the AXME Code setup + session flow
# with typed output for a polished demo recording.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CAST_FILE="$SCRIPT_DIR/demo.cast"
SVG_FILE="$REPO_ROOT/docs/demo.svg"

# Simulated typing function — writes characters with realistic delays
type_cmd() {
  local cmd="$1"
  local delay="${2:-0.04}"
  for (( i=0; i<${#cmd}; i++ )); do
    printf '%s' "${cmd:$i:1}"
    sleep "$delay"
  done
  echo ""
}

# Record with asciinema using a helper script
DEMO_SCRIPT="$SCRIPT_DIR/_demo_inner.sh"
cat > "$DEMO_SCRIPT" << 'INNER'
#!/usr/bin/env bash
set -euo pipefail

# Use a clean temp project for the demo
DEMO_PROJECT="/tmp/axme-demo-project"
rm -rf "$DEMO_PROJECT"
mkdir -p "$DEMO_PROJECT"

# Create a realistic small project
cat > "$DEMO_PROJECT/package.json" << 'PKG'
{
  "name": "my-api",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "start": "node src/index.js", "test": "node --test" },
  "dependencies": { "express": "^4.18.0", "pg": "^8.11.0" }
}
PKG

mkdir -p "$DEMO_PROJECT/src"
cat > "$DEMO_PROJECT/src/index.js" << 'SRC'
import express from 'express';
const app = express();
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(3000);
SRC

cat > "$DEMO_PROJECT/.gitignore" << 'GI'
node_modules/
.env
GI

# Step 1: Install
echo ""
echo -e "\033[1;36m# Step 1: Install AXME Code\033[0m"
echo ""
sleep 0.5
echo '$ curl -fsSL https://raw.githubusercontent.com/AxmeAI/axme-code/main/install.sh | bash'
sleep 0.8
echo "Detected platform: linux-x64"
echo "Fetching latest release..."
echo "Installing axme-code v0.2.0 (linux-x64)..."
sleep 0.5
echo ""
echo "Installed axme-code to /home/user/.local/bin/axme-code"
echo ""
sleep 1

# Step 2: Setup
echo -e "\033[1;36m# Step 2: Setup your project\033[0m"
echo ""
sleep 0.5
echo "$ cd my-api && axme-code setup"
sleep 0.8
echo ""
echo "AXME Code v0.2.0"
echo "Project: /home/user/my-api"
echo ""
echo "Scanning project..."
sleep 0.3
echo "  ✓ Detected stack: Node.js, Express, PostgreSQL"
echo "  ✓ Detected structure: 2 source files, package.json"
sleep 0.3
echo "  ✓ Applied preset: essential-safety"
echo "  ✓ Applied preset: ai-agent-guardrails"
sleep 0.3
echo "  ✓ Installed hooks: pre-tool-use, post-tool-use, session-end"
echo "  ✓ Configured MCP server in .mcp.json"
echo ""
echo "Knowledge base created in .axme-code/"
echo ""
sleep 1

# Step 3: Show what was created
echo -e "\033[1;36m# Step 3: What the agent sees\033[0m"
echo ""
sleep 0.5
echo "$ axme-code status"
sleep 0.5
echo ""
echo "AXME Code Status — my-api"
echo "─────────────────────────"
echo "Oracle:     stack.md, structure.md, patterns.md, glossary.md"
echo "Decisions:  12 active (8 required, 4 advisory)"
echo "Memories:   0 feedback, 0 patterns"
echo "Safety:     git(3 rules), bash(11 denied), fs(5 denied paths)"
echo "Sessions:   0 total"
echo "Backlog:    0 items"
echo ""
sleep 1

# Step 4: Safety demo
echo -e "\033[1;36m# Step 4: Safety in action\033[0m"
echo ""
sleep 0.5
echo "When Claude Code tries a dangerous command:"
echo ""
sleep 0.3
echo -e '  Agent: \033[0;33m"Let me force push to update main..."\033[0m'
echo -e '  $ git push --force origin main'
echo ""
sleep 0.5
echo -e "  \033[1;31m✗ BLOCKED by pre-tool-use hook\033[0m"
echo -e "  Rule: force push denied on protected branch 'main'"
echo -e "  The command was \033[1mnot executed\033[0m."
echo ""
sleep 1

# Step 5: Next session
echo -e "\033[1;36m# Step 5: Next session — full context loaded\033[0m"
echo ""
sleep 0.5
echo "When you start Claude Code next time, the agent calls axme_context:"
echo ""
sleep 0.3
echo "  → 4 oracle files (stack, structure, patterns, glossary)"
echo "  → 12 decisions (required + advisory)"
echo "  → Safety rules (git + bash + filesystem)"
echo "  → Handoff from previous session"
echo "  → Worklog timeline"
echo ""
echo -e "\033[1;32mYour agent never forgets.\033[0m"
echo ""
sleep 2
INNER

chmod +x "$DEMO_SCRIPT"

echo "Recording demo..."
asciinema rec \
  --overwrite \
  --cols 80 \
  --rows 24 \
  --command "bash $DEMO_SCRIPT" \
  "$CAST_FILE"

echo "Converting to SVG..."
svg-term \
  --in "$CAST_FILE" \
  --out "$SVG_FILE" \
  --window \
  --width 80 \
  --height 24 \
  --padding 10 \
  --no-cursor

echo ""
echo "Done!"
echo "  Cast: $CAST_FILE"
echo "  SVG:  $SVG_FILE"
echo ""
echo "To update the README, uncomment the demo image line and point to docs/demo.svg"
