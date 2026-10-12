#!/usr/bin/env bash
# Prints fresh values for JOB_SECRET and ENCRYPTION_KEY. Run it on YOUR machine, paste the output
# straight into Vercel (Settings, Environment Variables) and .env.local. Never paste it into chat,
# GitHub, a doc or a ticket, and keep a copy of ENCRYPTION_KEY in your password manager: losing it
# makes every stored Meta/Unite token unreadable.
set -euo pipefail
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
echo "JOB_SECRET=$(openssl rand -hex 32)"          # 64 hex chars (the app needs 32+)
echo "ENCRYPTION_KEY=$(openssl rand -base64 32)"   # 32 bytes, base64 (AES-256-GCM)
