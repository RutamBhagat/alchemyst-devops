#!/usr/bin/env bash
set -euo pipefail

metadata() {
  curl -fsS -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"
}

REPOSITORY_URL="$(metadata repo-url)"
REPOSITORY_REF="$(metadata repo-ref)"
ENGINE_URL="$(metadata engine-url)"
APP_DIR="/opt/devops-assignment"
WORKER_DIR="$APP_DIR/quickstart/workers/caller-worker"

if [[ -z "$REPOSITORY_URL" || -z "$ENGINE_URL" ]]; then
  echo "metadata attributes repo-url and engine-url are required" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git nodejs npm

if ! id iii >/dev/null 2>&1; then
  useradd --system --home-dir /opt/iii --create-home --shell /usr/sbin/nologin iii
fi

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

npm --prefix "$WORKER_DIR" install
npm --prefix "$WORKER_DIR" run build

mkdir -p /etc/iii
cat >/etc/iii/caller-worker.env <<EOF
III_URL=$ENGINE_URL
EOF

install -m 0644 "$APP_DIR/deploy/systemd/caller-worker.service" /etc/systemd/system/caller-worker.service
chown -R iii:iii /opt/iii "$APP_DIR" /etc/iii

systemctl daemon-reload
systemctl enable --now caller-worker
