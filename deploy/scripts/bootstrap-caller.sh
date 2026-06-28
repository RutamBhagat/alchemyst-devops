#!/usr/bin/env bash
set -euo pipefail

metadata() {
  # Terraform passes deploy-time settings through VM metadata attributes.
  curl -fsS -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"
}

REPOSITORY_URL="$(metadata repo-url)"
APP_DIR="/opt/devops-assignment"
WORKER_DIR="$APP_DIR/quickstart/workers/caller-worker"

if [[ -z "$REPOSITORY_URL" ]]; then
  echo "metadata attribute repo-url is required" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs

if ! id iii >/dev/null 2>&1; then
  # Run III services as a locked-down system user instead of root.
  useradd --system --home-dir /opt/iii --create-home --shell /usr/sbin/nologin iii
fi

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

# Do not remove: noisy services can fill small boot disks without a journald cap.
install -d -m 0755 /etc/systemd/journald.conf.d
install -m 0644 "$APP_DIR/deploy/systemd/journald.conf" /etc/systemd/journald.conf.d/60-devops-assignment.conf
systemctl restart systemd-journald

npm --prefix "$WORKER_DIR" ci
npm --prefix "$WORKER_DIR" run build

install -m 0644 "$APP_DIR/deploy/systemd/caller-worker.service" /etc/systemd/system/caller-worker.service
chown -R iii:iii /opt/iii "$APP_DIR"

systemctl daemon-reload
systemctl enable --now caller-worker
