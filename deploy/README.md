# Telecom Worker Host Operations & Supervision Guide

This directory contains deployment configuration and operations documentation for the continuous Telecom background worker processes:
1. `telecom-voice-extension` (`src/workers/telecomVoiceExtensionWorker.ts`)
2. `telecom-reconciliation` (`src/workers/telecomReconciliationWorker.ts`)
3. `telecom-termination` (`src/workers/telecomTerminationWorker.ts`)

---

## 1. Architecture & Supervision Model

### Process Hierarchy
```
Linux OS Boot
   └── systemd (pm2-voiphub.service)
        └── PM2 Master Process Supervisor
             ├── telecom-voice-extension (Node process / TSX)
             ├── telecom-reconciliation  (Node process / TSX)
             └── telecom-termination     (Node process / TSX)
```

- **Process Supervision**: PM2 manages all three worker processes independently for failure isolation (`autorestart: true`, `max_restarts: 10`, `min_uptime: 5s`).
- **OS Boot Recovery**: Systemd restores the saved PM2 process list automatically on VPS reboot (`pm2 startup` -> `pm2 save`).
- **Single Supervision Authority**: PM2 is the single process supervisor. We avoid competing individual systemd units per worker to prevent double supervision.

---

## 2. Dedicated Non-Root Application User & File Hardening

- **Dedicated User**: Create a dedicated, non-root system user named `voiphub` (no sudo privileges):
  ```bash
  sudo useradd -m -s /bin/bash voiphub
  ```
- **Application Directory**: Clone the repository into `/opt/telecom-workers/app` owned by `voiphub:voiphub`.
- **Environment Secrets File**: Store production secrets outside the repository in `/etc/voip-hub/worker.env` (or `/opt/telecom-workers/app/.env.production`):
  ```bash
  sudo mkdir -p /etc/voip-hub
  sudo touch /etc/voip-hub/worker.env
  sudo chown -R voiphub:voiphub /etc/voip-hub
  sudo chmod 600 /etc/voip-hub/worker.env
  ```

---

## 3. Firewall & Operating System Hardening

- **Inbound Firewall (UFW)**: Default DENY incoming ports.
  ```bash
  sudo ufw default deny incoming
  sudo ufw default allow outgoing
  sudo ufw allow 22/tcp  # SSH access (Restrict to admin IP where possible)
  sudo ufw enable
  ```
- **Inbound HTTP Ports**: **`NO INBOUND HTTP PORTS (80/443) REQUIRED`**. Workers initiate outbound HTTPS connections to Supabase and Twilio APIs. Exposing zero inbound HTTP ports eliminates network attack surface.
- **SSH Hardening**: Key-only authentication (`PasswordAuthentication no` in `/etc/ssh/sshd_config`).
- **Time Synchronization**: Server clock MUST be synchronized via `systemd-timesyncd` in `UTC` timezone.

---

## 4. Region Selection Strategy

- **VPS Region Selection**: Select the VPS region **after verifying the exact geographical region of the Supabase PostgreSQL database and Twilio API endpoints** (e.g., US East / N. Virginia).
- **Latency Objective**: Minimize network roundtrip latency for atomic DB claims (`claim_next_due_call_extension_atomic`) and provider state fetch/hangup calls.

---

## 5. Node.js Runtime & Build Decision

- **Supported Node Version**: `Node.js 22 LTS` (requires `npm ci` with committed `package-lock.json`).
- **Runtime Approach (TSX)**: For Stage B.1, workers run via `tsx` (`npm run worker:*`). This preserves application architecture and path alias resolution without requiring a complex multi-entrypoint build splitting setup.

---

## 6. Operational Health vs Web Health

> [!IMPORTANT]
> **`WEB_HEALTH != WORKER_HEALTH`**
>
> Vercel returning `HTTP 200 OK` on the web app does NOT prove telecom safety workers are running.
>
> **Worker Operational Health is defined by**:
> 1. PM2 process state (`pm2 status`).
> 2. Freshness of worker heartbeats in `public.telecom_runner_heartbeats` (`expires_at > NOW()`).

### Heartbeat Freshness Thresholds (Configurable)
- **STALE**: >15 seconds without heartbeat update.
- **CRITICAL**: >30 seconds without heartbeat update (indicates worker daemon process down).

---

## 7. Deterministic Setup & Update Sequence

```bash
# 1. Fetch & checkout approved release Git SHA (Never deploy unverified moving main)
git fetch origin
git checkout --detach <APPROVED_SHA>

# 2. Install dependencies deterministically
npm ci

# 3. Validate code integrity
npx tsc --noEmit
npm run build

# 4. Start workers cleanly with PM2
pm2 start deploy/ecosystem.config.js

# 5. Save process list & configure systemd boot restoration
pm2 save
# Note: Review output of 'pm2 startup' before running elevated command

# 6. Verify worker status & DB heartbeats
pm2 status
npx -y tsx scratch/verify_rpc_permissions.ts
```

---

## 8. Safe Initial Worker Start & Rollback Procedure

### Safe Initial Start
- Initial worker deployment MUST occur with:
  - `TELECOM_PREPAID_ENFORCEMENT_MODE=shadow_log`
  - `TELECOM_ACTIVE_CALL_PROVIDER_MUTATIONS_ENABLED=false`
- Starting workers in `shadow_log` mode allows heartbeats and polling logic to be verified safely with zero provider mutations or customer financial exposure.

### Rollback Procedure
If worker deployment encounters an operational issue:
1. Ensure `TELECOM_PREPAID_ENFORCEMENT_MODE=shadow_log` and provider gates remain `OFF`.
2. Stop workers: `pm2 stop ecosystem.config.js`.
3. Checkout previous verified Git SHA: `git checkout <PREVIOUS_SHA>`.
4. Re-install & build: `npm ci && npm run build`.
5. Restart PM2: `pm2 reload ecosystem.config.js`.
6. Verify heartbeat recovery in `public.telecom_runner_heartbeats`.
7. **`NEVER DELETE DATABASE ACCOUNTING OR PROVIDER OPERATION RECORDS AS ROLLBACK.`**
