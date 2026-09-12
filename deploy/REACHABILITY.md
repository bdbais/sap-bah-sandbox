# Making the sandbox reachable from SAP Integration Suite

The sandbox binds to the LAN by default (`HOST=0.0.0.0`). That is enough for
Postman, curl, and anything else on the same network. A **Cloud Foundry CPI
tenant cannot reach a private address** — it needs one of the routes below.

Pick by where the calling IFlow runs.

---

## 1. LAN only — Postman, curl, local tools

Nothing to do. Point the client at `http://<linux-box-ip>:8080/mock/<slug>`.

Restrict who may call the mocks by listing your subnets:

```bash
# in .env
ALLOW_CIDRS=192.168.1.0/24,10.0.0.0/8
```

Loopback is always permitted so the UI keeps working on the box itself.

---

## 2. SAP Cloud Connector — the production-shaped option

If you already run Cloud Connector for on-premise connectivity, this is the
right route: no public exposure, and the IFlow uses the same
`ProxyType=OnPremise` pattern as a real backend.

1. Cloud Connector → **Cloud To On-Premise** → **Add**
   - Back-end Type: `Non-SAP System`
   - Protocol: `HTTP`
   - Internal Host / Port: `<linux-box-ip>` / `8080`
   - Virtual Host / Port: `sapbah-sandbox` / `8080`
2. Add a resource path `/mock` with **Path And All Sub-Paths**.
3. In the IFlow's HTTP or OData receiver channel:
   - Address: `http://sapbah-sandbox:8080/mock/<slug>`
   - Proxy Type: `On-Premise`
   - Location ID: whatever your Cloud Connector uses

No TLS certificate needed — Cloud Connector terminates the tunnel.

---

## 3. Cloudflare Tunnel — quickest public route

Gives a stable HTTPS hostname with a real certificate and no inbound firewall
rule. Free for this use.

```bash
# Install
curl -fsSL https://pkg.cloudflare.com/cloudflared-ascii.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared

# Authenticate and create a named tunnel
cloudflared tunnel login
cloudflared tunnel create sapbah
cloudflared tunnel route dns sapbah sapbah.example.com
```

`/etc/cloudflared/config.yml`:

```yaml
tunnel: sapbah
credentials-file: /root/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: sapbah.example.com
    service: http://localhost:8080
  - service: http_status:404
```

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

The IFlow then calls `https://sapbah.example.com/mock/<slug>` with
Proxy Type `Internet`.

Set `TRUST_PROXY=true` in `.env`. Every request now reaches the app from
cloudflared on loopback; without it `ALLOW_CIDRS` would wave the whole
internet through and the traffic log would show `127.0.0.1` for every call.

> **Set `ADMIN_KEY` before exposing anything.** The tunnel publishes the whole
> app, including `/api`, and without a key the admin API is unauthenticated —
> anyone who finds the hostname could edit or delete your mocks.
> `deploy/install.sh` generates one for you.

---

## 4. nginx reverse proxy — your own domain and certificate

```nginx
server {
    listen 443 ssl http2;
    server_name sapbah.example.com;

    ssl_certificate     /etc/letsencrypt/live/sapbah.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sapbah.example.com/privkey.pem;

    # Expose only the mocks publicly; keep the admin UI on the LAN.
    location /mock/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        allow 192.168.1.0/24;
        deny  all;
        proxy_pass http://127.0.0.1:8080;

        # The Network tab streams over a WebSocket.
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;
    }
}
```

Then set `HOST=127.0.0.1` and `TRUST_PROXY=true` in `.env`, so only nginx can
reach the app directly and the app believes the address nginx forwards.

With `TRUST_PROXY=true`, the address nginx appends to `X-Forwarded-For` is what
the traffic log records and what `ALLOW_CIDRS` checks, so calls from CPI show
the tenant's egress IP rather than the proxy's. Leave it off when clients
connect directly: anyone can send that header.

---

## Which one to use

| Situation | Route |
|---|---|
| Testing from your own machine | LAN (1) |
| CPI tenant, Cloud Connector already in place | Cloud Connector (2) |
| CPI tenant, want it working in ten minutes | Cloudflare Tunnel (3) |
| CPI tenant, corporate domain and certificate required | nginx (4) |
