#!/usr/bin/env bash
# Simulated AXME Code demo — continuous flow, no screen breaks
set -euo pipefail

typeit() {
  local text="$1"
  for (( i=0; i<${#text}; i++ )); do
    printf '%s' "${text:$i:1}"
    sleep 0.0$(( RANDOM % 6 + 3 ))
  done
}

run_cmd() {
  printf '\033[1;32m❯\033[0m '
  typeit "$1"
  sleep 0.3
  echo ""
  sleep 0.2
}

clear
sleep 0.8
echo -e "\033[1;36m# Install & Setup\033[0m"
echo ""
sleep 0.3

run_cmd "curl -fsSL https://raw.githubusercontent.com/AxmeAI/axme-code/main/install.sh | bash"
sleep 0.3
echo "Detected platform: linux-x64"
sleep 0.2
echo "Installing axme-code v0.2.0 (linux-x64)..."
sleep 0.5
echo -e "\033[1;32m✓\033[0m Installed to ~/.local/bin/axme-code"
echo ""
sleep 0.8

run_cmd "cd my-api && axme-code setup"
sleep 0.3
echo ""
echo "Scanning project..."
sleep 0.4
echo -e "  \033[1;32m✓\033[0m Oracle created: stack, structure, patterns, glossary"
sleep 0.25
echo -e "  \033[1;32m✓\033[0m \033[1;33m14 decisions\033[0m extracted from CLAUDE.md, configs, and code"
sleep 0.25
echo -e "  \033[1;32m✓\033[0m \033[1;35m6 memories\033[0m extracted from notes and session history"
sleep 0.25
echo -e "  \033[1;32m✓\033[0m \033[1;31m19 safety rules\033[0m from presets + project files"
sleep 0.25
echo -e "  \033[1;32m✓\033[0m Hooks installed, MCP server configured"
echo ""
echo -e "\033[1;32m✓ Knowledge base created in .axme-code/\033[0m"
sleep 4

# ─── Status — continuous, no clear ───
echo ""
echo ""
run_cmd "axme-code status"
sleep 0.3
echo ""
echo -e "\033[1mAXME Code Status — my-api\033[0m"
echo "────────────────────────────────────────"
echo ""
echo -e "  Oracle:     stack.md, structure.md, patterns.md, glossary.md"
echo -e "  Decisions:  \033[1;33m12 active\033[0m (8 required, 4 advisory)"
echo -e "  Memories:   0 feedback, 0 patterns"
echo -e "  Safety:     \033[1;31m3 git rules, 11 denied commands, 5 denied paths\033[0m"
echo -e "  Sessions:   0 total"
sleep 5

# ─── Safety — continuous ───
echo ""
echo ""
echo -e "\033[1;36m# Safety — hooks, not prompts\033[0m"
echo ""
sleep 0.5
echo "Claude Code tries a dangerous command:"
echo ""
sleep 0.5
echo -e '  Agent: \033[0;33m"I'\''ll force push to update the branch..."\033[0m'
sleep 0.5
echo -e '  \033[0;37m$ git push --force origin main\033[0m'
echo ""
sleep 1
echo -e "  \033[1;31m✗ BLOCKED\033[0m by pre-tool-use hook"
echo -e "  Rule: force push denied on protected branch '\033[1mmain\033[0m'"
echo -e "  The command was \033[1;4mnot executed\033[0m."
sleep 5

# ─── Next session — continuous ───
echo ""
echo ""
echo -e "\033[1;36m# Next session — zero re-explaining\033[0m"
echo ""
sleep 0.3
echo "Agent calls axme_context at session start:"
echo ""
sleep 0.5
echo -e "  → \033[1;33m17 decisions\033[0m      (3 new from last session)"
sleep 0.3
echo -e "  → \033[1;35m9 memories\033[0m        (3 new from last session)"
sleep 0.3
echo -e "  → \033[1;31m21 safety rules\033[0m   (2 new from last session)"
sleep 0.3
echo -e "  → \033[1;34mHandoff\033[0m           where work stopped, what's next"
echo ""
echo ""
sleep 1
echo -e "\033[1;32m  Your agent never forgets.\033[0m"
echo ""
sleep 10
