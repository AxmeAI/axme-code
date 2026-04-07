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
  trap 'rm -f "$tmp"' EXIT

  download "$download_url" "$tmp"

  mkdir -p "$INSTALL_DIR"
  mv "$tmp" "${INSTALL_DIR}/axme-code"
  chmod +x "${INSTALL_DIR}/axme-code"

  echo ""
  echo "Installed axme-code to ${INSTALL_DIR}/axme-code"

  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
    echo ""
    echo "Add to your PATH:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
  fi

  echo ""
  echo "Get started:"
  echo "  cd your-project"
  echo "  axme-code setup"
}

main "$@"
