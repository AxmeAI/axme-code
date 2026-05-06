#!/usr/bin/env bash
set -euo pipefail

REPO="AxmeAI/axme-code"
INSTALL_DIR="${AXME_INSTALL_DIR:-$HOME/.local/bin}"

# Detect OS and architecture
detect_platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$os" in
    linux)  os="linux" ;;
    darwin) os="darwin" ;;
    *)      echo "Unsupported OS: $os" >&2; exit 1 ;;
  esac

  case "$arch" in
    x86_64|amd64)  arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *)             echo "Unsupported architecture: $arch" >&2; exit 1 ;;
  esac

  echo "${os}-${arch}"
}

# Get latest release tag from GitHub API
get_latest_version() {
  local url="https://api.github.com/repos/${REPO}/releases/latest"
  if command -v curl &>/dev/null; then
    curl -fsSL "$url" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"//;s/".*//'
  elif command -v wget &>/dev/null; then
    wget -qO- "$url" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"//;s/".*//'
  else
    echo "Neither curl nor wget found" >&2; exit 1
  fi
}

# Download binary
download() {
  local url="$1" dest="$2"
  if command -v curl &>/dev/null; then
    curl -fsSL -o "$dest" "$url"
  else
    wget -qO "$dest" "$url"
  fi
}

main() {
  local platform version download_url tmp

  platform="$(detect_platform)"
  echo "Detected platform: ${platform}"

  if [ -n "${1:-}" ]; then
    version="$1"
  else
    echo "Fetching latest release..."
    version="$(get_latest_version)"
  fi

  if [ -z "$version" ]; then
    echo "Could not determine latest version. Specify version: ./install.sh v0.1.0" >&2
    exit 1
  fi

  echo "Installing axme-code ${version} (${platform})..."

  download_url="https://github.com/${REPO}/releases/download/${version}/axme-code-${platform}"

  tmp="$(mktemp)"
  trap 'rm -f "${tmp:-}"' EXIT INT TERM

  download "$download_url" "$tmp"

  mkdir -p "$INSTALL_DIR"
  mv "$tmp" "${INSTALL_DIR}/axme-code"
  chmod +x "${INSTALL_DIR}/axme-code"

  echo ""
  echo "Installed axme-code to ${INSTALL_DIR}/axme-code"

  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
    print_path_instruction "$INSTALL_DIR"
  fi

  echo ""
  echo "Get started:"
  echo "  cd your-project"
  echo "  axme-code setup"
}

# Detect the user's login shell from $SHELL (most reliable across distros);
# fallback to getent passwd. Returns the shell base name (bash/zsh/fish/tcsh/
# csh/...) or "unknown" so the caller can print a generic hint.
detect_shell() {
  local shell_path=""
  if [ -n "${SHELL:-}" ]; then
    shell_path="$SHELL"
  elif command -v getent &>/dev/null && [ -n "${USER:-}" ]; then
    shell_path="$(getent passwd "$USER" 2>/dev/null | cut -d: -f7)"
  fi
  case "$(basename "${shell_path:-unknown}")" in
    bash)  echo "bash" ;;
    zsh)   echo "zsh" ;;
    fish)  echo "fish" ;;
    tcsh)  echo "tcsh" ;;
    csh)   echo "csh" ;;
    *)     echo "unknown" ;;
  esac
}

# Print shell-aware instructions for adding $1 to PATH. Covers bash/zsh/fish/
# tcsh/csh; unknown shells get the bash/zsh form as a safe default plus a
# pointer to manually consult the shell's docs. We do NOT auto-edit any rc
# file — the user runs the command themselves so they can audit the change.
print_path_instruction() {
  local dir="$1" shell rc add_line
  shell="$(detect_shell)"
  echo ""
  echo "${dir} is not on your PATH."
  case "$shell" in
    bash)
      rc="$HOME/.bashrc"
      add_line="export PATH=\"${dir}:\$PATH\""
      echo "Detected shell: bash. Add it with:"
      echo "  echo '${add_line}' >> ${rc}"
      echo "  source ${rc}"
      ;;
    zsh)
      rc="$HOME/.zshrc"
      add_line="export PATH=\"${dir}:\$PATH\""
      echo "Detected shell: zsh. Add it with:"
      echo "  echo '${add_line}' >> ${rc}"
      echo "  source ${rc}"
      ;;
    fish)
      rc="$HOME/.config/fish/config.fish"
      add_line="set -gx PATH ${dir} \$PATH"
      echo "Detected shell: fish. Add it with:"
      echo "  mkdir -p $(dirname "$rc") && echo '${add_line}' >> ${rc}"
      echo "  source ${rc}"
      ;;
    tcsh)
      rc="$HOME/.tcshrc"
      add_line="setenv PATH ${dir}:\$PATH"
      echo "Detected shell: tcsh. Add it with:"
      echo "  echo '${add_line}' >> ${rc}"
      echo "  source ${rc}"
      ;;
    csh)
      rc="$HOME/.cshrc"
      add_line="setenv PATH ${dir}:\$PATH"
      echo "Detected shell: csh. Add it with:"
      echo "  echo '${add_line}' >> ${rc}"
      echo "  source ${rc}"
      ;;
    *)
      echo "Could not detect your shell (\$SHELL=${SHELL:-unset}). Pick the form that matches:"
      echo "  bash/zsh:  export PATH=\"${dir}:\$PATH\"      (in ~/.bashrc or ~/.zshrc)"
      echo "  fish:      set -gx PATH ${dir} \$PATH         (in ~/.config/fish/config.fish)"
      echo "  tcsh/csh:  setenv PATH ${dir}:\$PATH          (in ~/.tcshrc or ~/.cshrc)"
      echo "Then open a new terminal or 'source' the rc file."
      ;;
  esac
}

# Only run main when executed directly, not when sourced. Lets us source
# the script for unit testing of detect_shell / print_path_instruction
# without triggering a real download+install.
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  main "$@"
fi
