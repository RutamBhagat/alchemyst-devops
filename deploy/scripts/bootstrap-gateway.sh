#!/usr/bin/env bash
set -euo pipefail

metadata() {
  curl -fsS -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"
}

REPOSITORY_URL="$(metadata repo-url)"
REPOSITORY_REF="$(metadata repo-ref)"
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
  useradd --system --home-dir /opt/iii --create-home --shell /usr/sbin/nologin iii
fi

mkdir -p /opt/iii /etc/iii

if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch --prune origin
else
  rm -rf "$APP_DIR"
  git clone "$REPOSITORY_URL" "$APP_DIR"
fi

git -C "$APP_DIR" checkout "$REPOSITORY_REF"
git -C "$APP_DIR" pull --ff-only || true

install -d -m 0755 /etc/systemd/journald.conf.d
install -m 0644 "$APP_DIR/deploy/systemd/journald.conf" /etc/systemd/journald.conf.d/iii.conf
systemctl restart systemd-journald

curl -fsSL https://install.iii.dev/iii/main/install.sh | VERSION="$III_VERSION" BIN_DIR=/usr/local/bin sh

install -m 0644 "$APP_DIR/deploy/gateway/iii-config.yaml" /opt/iii/iii-config.yaml
install -m 0644 "$APP_DIR/deploy/gateway/nginx.conf" /etc/nginx/sites-available/iii-api
ln -sfn /etc/nginx/sites-available/iii-api /etc/nginx/sites-enabled/iii-api
rm -f /etc/nginx/sites-enabled/default

install -m 0644 "$APP_DIR/deploy/systemd/iii-engine.service" /etc/systemd/system/iii-engine.service
chown -R iii:iii /opt/iii "$APP_DIR"

systemctl daemon-reload
systemctl enable --now iii-engine
nginx -t
systemctl enable --now nginx
