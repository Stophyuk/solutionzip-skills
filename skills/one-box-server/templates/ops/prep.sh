#!/usr/bin/env bash
# prep.sh — one-time server preparation (Ubuntu 22.04 / 24.04). Run as root once, after the ops repo is at /srv/ops:
#
#   sudo install -d -o ubuntu -g ubuntu /srv && git clone <your private ops repo> /srv/ops
#   # edit /srv/ops/ops/ops.conf and /srv/ops/ops/apps.conf first
#   sudo bash /srv/ops/ops/prep.sh && sudo reboot     # the reboot makes the docker group apply
#
# Safe to run again: each step checks first or rewrites the same content.
set -euxo pipefail
. /srv/ops/ops/ops.conf
timedatectl set-timezone "$HOST_TZ"

# swap 4G — Next.js builds on the box itself peaked at 1.5–2.5 GB; without swap the OOM killer picks a database
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
echo 'vm.swappiness=10' > /etc/sysctl.d/90-swap.conf && sysctl --system >/dev/null

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg git jq unzip ufw unattended-upgrades fail2ban

# Docker from the official repo. Container logs are capped here once, so no container can fill the disk with them.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" }, "live-restore": true }
JSON
systemctl restart docker && usermod -aG docker "$OPS_USER"

# AWS CLI v2 — backup upload to any S3-compatible bucket
if ! command -v aws >/dev/null; then
  case $(uname -m) in aarch64) arch=aarch64 ;; *) arch=x86_64 ;; esac
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$arch.zip" -o /tmp/awscliv2.zip
  unzip -qo /tmp/awscliv2.zip -d /tmp && /tmp/aws/install --update && rm -rf /tmp/aws /tmp/awscliv2.zip
fi

# security updates only; reboots are done by a person in the monthly window (check /var/run/reboot-required)
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
sed -i 's|^//\s*Unattended-Upgrade::Automatic-Reboot .*|Unattended-Upgrade::Automatic-Reboot "false";|' /etc/apt/apt.conf.d/50unattended-upgrades

# ufw doubles the provider's firewall; docker publishes only 80/443 — everything else binds to 127.0.0.1
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw --force enable
systemctl enable --now fail2ban

# layout: /srv/ops (this repo) · /srv/edge (Caddy) · /srv/<app> for every app in apps.conf
mkdir -p /srv/edge/data /srv/edge/config /srv/edge/logs /srv/ops/backups
for app in $(awk '!/^#/ && NF { print $1 }' /srv/ops/ops/apps.conf); do mkdir -p "/srv/$app"; done
chown -R "$OPS_USER:$OPS_USER" /srv
install -m 0755 /srv/ops/bin/dc /usr/local/bin/dc
# logs: 30 days. journald for whatever logs there; cron trims Caddy's files (trim-logs.sh)
install -m 0755 -d /etc/systemd/journald.conf.d
install -m 0644 /srv/ops/ops/journald.conf /etc/systemd/journald.conf.d/retention.conf && systemctl restart systemd-journald
install -m 0644 /srv/ops/ops/cron.d/ops /etc/cron.d/ops
docker network inspect edge >/dev/null 2>&1 || docker network create edge
echo "prep done — reboot once so the docker group applies: sudo reboot"
