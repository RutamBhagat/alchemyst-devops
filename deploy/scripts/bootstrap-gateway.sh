#!/usr/bin/env bash
set -euo pipefail

metadata() {
  # Terraform passes deploy-time settings through VM metadata attributes.
  curl -fsS -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"
}

REPOSITORY_URL="$(metadata repo-url)"
III_VERSION="$(metadata iii-version)"
APP_DIR="/opt/devops-assignment"

if [[ -z "$REPOSITORY_URL" ]]; then
  echo "metadata attribute repo-url is required" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git jq nginx

if ! id iii >/dev/null 2>&1; then
  # Run III services as a locked-down system user instead of root.
  useradd --system --home-dir /opt/iii --create-home --shell /usr/sbin/nologin iii
fi

mkdir -p /opt/iii /etc/iii

# Reuse an existing checkout on reboot, otherwise create the app directory.
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch --prune origin
else
  rm -rf "$APP_DIR"
  git clone "$REPOSITORY_URL" "$APP_DIR"
fi

# Startup always runs the repository's main branch.
git -C "$APP_DIR" checkout main
git -C "$APP_DIR" pull --ff-only origin main

# Keep service logs bounded so boot disks do not fill under noisy workers.
install -d -m 0755 /etc/systemd/journald.conf.d
install -m 0644 "$APP_DIR/deploy/systemd/journald.conf" /etc/systemd/journald.conf.d/iii.conf
systemctl restart systemd-journald

# Install the III CLI version recorded in Terraform metadata.
curl -fsSL https://install.iii.dev/iii/main/install.sh | VERSION="$III_VERSION" BIN_DIR=/usr/local/bin sh

install -m 0644 "$APP_DIR/deploy/gateway/iii-config.yaml" /opt/iii/iii-config.yaml
install -m 0644 "$APP_DIR/deploy/gateway/nginx.conf" /etc/nginx/sites-available/iii-api
# Point nginx at the repo-owned gateway config and remove Debian's default site.
ln -sfn /etc/nginx/sites-available/iii-api /etc/nginx/sites-enabled/iii-api
rm -f /etc/nginx/sites-enabled/default

install -m 0644 "$APP_DIR/deploy/systemd/iii-engine.service" /etc/systemd/system/iii-engine.service
chown -R iii:iii /opt/iii "$APP_DIR"

systemctl daemon-reload
systemctl enable --now iii-engine
# Validate nginx config before starting the public API proxy.
nginx -t
systemctl enable --now nginx
