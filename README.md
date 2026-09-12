# SAP Business Accelerator Hub — Sandbox

[![CI](https://github.com/bdbais/sap-bah-sandbox/actions/workflows/ci.yml/badge.svg)](https://github.com/bdbais/sap-bah-sandbox/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/bdbais/sap-bah-sandbox)](https://github.com/bdbais/sap-bah-sandbox/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Donate](https://img.shields.io/badge/donate-PayPal-00457C.svg)](https://paypal.me/bellizia)

A self-hosted test rig for SAP Business Accelerator Hub APIs: it tracks what
changes in the Hub catalog, serves mock endpoints from real specifications,
generates and runs a test suite against them, and logs every inbound call the
way browser dev-tools do.

Two everyday uses: **test your own products against SAP APIs without fighting
SAP authentication** — point them at a mock that answers like the real thing —
and **find out when an API or artifact on the Hub publishes a new version**.

Node.js + TypeScript, one SQLite file, no Docker, no native modules.

> Independent open-source project, not affiliated with or endorsed by SAP SE.
> SAP and SAP Business Accelerator Hub are trademarks of SAP SE.

---

## What it does

| # | Capability | Where |
|---|---|---|
| 1 | Crawls the Hub catalog, versions every package and artifact, and writes a per-run change report | **Catalog** and **Changes** tabs |
| 2 | Serves mock APIs from OpenAPI/Swagger/EDMX specs, with faker, imported fixture, AI-generated, or proxied data | **Mocks** tab, `/mock/<slug>` |
| 3 | Generates one test per operation, fires it, validates the response against its declared schema | **Tests** tab |
| 4 | Records every request/response with headers, payloads and timing, streamed live | **Network** tab |

---

## Install

Download the source of the [latest release](https://github.com/bdbais/sap-bah-sandbox/releases/latest)
(zip or tar.gz) and unpack it, or clone the repository:

```bash
git clone https://github.com/bdbais/sap-bah-sandbox.git
cd sap-bah-sandbox
```

### Stand-alone (Windows, macOS, Linux) — no prerequisites

Each installer downloads its own Node runtime, so nothing is installed
system-wide and an existing or company-managed Node is never touched.

```powershell
powershell -ExecutionPolicy Bypass -File .\install\install.ps1     # Windows
```
```bash
./install/install.sh                                               # macOS / Linux
```

It installs into one self-contained folder, generates an `ADMIN_KEY`, registers
autostart (Task Scheduler / launchd / `systemd --user`), and starts it. Full
details, options and uninstall: [install/README.md](install/README.md).

Afterwards you get a control script:

```bash
sapbah start | stop | status | logs | open
sapbah sync --filter SuccessFactors
sapbah test --mock hubcat --read-only
sapbah update                 # install the latest release now
```

### Shared server (Linux, system-wide)

For a box the whole team points CPI at — dedicated service user, starts at boot
without anyone logging in:

```bash
sudo ./deploy/install.sh
```

That creates a `sapbah` service user, installs to `/opt/sap-bah-sandbox`,
compiles, generates an `ADMIN_KEY`, and enables two units:

- `sapbah-sandbox.service` — the server
- `sapbah-sync.timer` — nightly catalog sync at 02:30 (with jitter)

```bash
systemctl status sapbah-sandbox
journalctl -u sapbah-sandbox -f
systemctl start sapbah-sync          # sync now
systemctl list-timers sapbah-sync    # next scheduled run
```

### From source, for development

Needs **Node.js 22.5 or newer** (24 LTS recommended) already on the machine —
this is the only path that does. The database is Node's built-in `node:sqlite`,
so there is nothing to compile: no `node-gyp`, no build-essential, no Python.

```bash
npm install
cp .env.example .env
npm run dev            # tsx watch, no build step
# or
npm run build && npm start
```

> On Windows, keep the checkout **outside** a OneDrive-synced folder, or exclude
> it from sync. `node_modules` is tens of thousands of files and OneDrive will
> chew through bandwidth trying to replicate them.

---

## Updates

A stand-alone install keeps itself current. Every six hours the server asks
GitHub for the latest release — one anonymous request to `api.github.com`,
nothing else is sent — and when there is a newer one:

- the UI shows a banner with the release notes and an **Update now** button;
- with `AUTO_UPDATE=true` (the default) it installs the release by itself once
  the sandbox has had no mock calls, syncs or test runs for 15 minutes.

Updating downloads the release, re-runs its installer into the same folder,
and restarts. `data/` and `.env` are kept; a log goes to `data/update.log`. If
an update fails, the installed version is started again and the same release
is not retried for 24 hours. From the command line:

```bash
sapbah update --check     # only look
sapbah update             # install the latest release now
```

Turn it off with `AUTO_UPDATE=false` (notice only) or `UPDATE_CHECK=false`
(no requests at all). A source checkout and the shared `/opt` server install
only show the notice: update those by pulling and re-running their installer.

Releases are published by pushing a `vX.Y.Z` tag that matches `package.json`;
[.github/workflows/release.yml](.github/workflows/release.yml) builds it and
creates the GitHub release that installs pick up.

---

## Making it reachable from SAP CPI

A Cloud Foundry CPI tenant cannot call a private address. See
[deploy/REACHABILITY.md](deploy/REACHABILITY.md) for the four routes —
LAN-only, SAP Cloud Connector, Cloudflare Tunnel, and nginx — with working
configuration for each.

**Set `ADMIN_KEY` before exposing the sandbox beyond the LAN.** Without it the
`/api` routes and the live `/ws` feed are unauthenticated. Behind nginx or a
tunnel, also set `TRUST_PROXY=true`.

Whatever the key setting, the admin API refuses requests that a browser marks
as coming from another website, so a page you happen to open cannot drive it.
Mock responses are sent with `Content-Security-Policy: sandbox`, so content
from an imported spec or a proxied backend never runs in the UI's origin.

---

## Configuration

Everything lives in `.env`; see [.env.example](.env.example) for the annotated
list. The settings that matter most:

| Variable | Purpose |
|---|---|
| `HOST` / `PORT` | `0.0.0.0:8080` by default. Use `127.0.0.1` when behind nginx. |
| `ALLOW_CIDRS` | Restricts who may call `/mock`. Empty means everyone. |
| `TRUST_PROXY` | `true` behind nginx or a tunnel: judge callers by the forwarded address. |
| `ADMIN_KEY` | Required in the `X-Sandbox-Key` header on `/api` (and for `/ws`). Empty disables auth. |
| `HUB_API_KEY` / `HUB_COOKIE` | Lets the sync download specifications (see below). |
| `HUB_FILTER` | Crawl only packages whose name contains this text. |
| `AI_PROVIDER` | `ollama` (default), `claude`, or `none`. |
| `UPDATE_CHECK` / `AUTO_UPDATE` | Look for new releases / install them when idle. Both `true` by default. |

---

## 1. Catalog tracking

### What works without any credentials

The Hub's package and artifact catalog is readable anonymously, so version
tracking, change detection and reports need **no login at all**:

```
GET https://api.sap.com/odata/1.0/catalog.svc/ContentEntities.ContentPackages
GET .../ContentEntities.ContentPackages('<name>')/Artifacts
```

A full crawl is ~1950 packages and ~42,000 artifacts and takes a few minutes.
Use a filter to narrow it:

```bash
node dist/cli/sync.js --filter SuccessFactors
```

> The Hub accepts an OData `$filter` on that endpoint and then **ignores it**,
> returning the whole catalog. The sync therefore pages the full package list
> and matches locally — the saving is downstream, where only matching packages
> have their artifacts fetched.

### What needs credentials

Downloading an artifact's actual specification (`Artifacts(...)/$value`) is
gated: without a session the Hub answers with its login page. Set
`HUB_API_KEY` (api.sap.com → avatar → Settings → Show API Key) or paste a
logged-in `HUB_COOKIE`, then sync with `--specs`.

If neither is set, the sync says so and skips only the spec downloads —
**catalog change tracking is unaffected**. You can always import spec files by
hand from the Mocks tab, which is the path that never breaks.

### Reports

Every run writes to `data/reports/run-NNNNN-<timestamp>/`:

- `report.html` — styled, standalone, light/dark, breaking changes highlighted
- `report.json` — the same data for scripting
- `changes.csv` — for Excel

Change detection covers new/removed/republished packages and artifacts, version
moves, and — when specs are available — structural diffs of the specification
itself (added/removed operations, parameter and response-field changes),
flagged **breaking** when a client could break.

---

## 2. Mock server

Import a specification (OpenAPI 3, Swagger 2, or OData EDMX — a `$metadata`
document works), press **mount**, and the operations are live at
`/mock/<slug>/…`.

For OData specs the server implements the query options CPI actually sends:

```
$filter   eq ne gt ge lt le, and/or/not, parentheses,
          substringof startswith endswith contains tolower toupper
          length indexof concat trim substring
          year month day hour minute second, round floor ceiling
$select   $orderby   $top   $skip   $expand
$inlinecount=allpages   $count=true
$metadata   service document   key predicates incl. composite keys
```

Responses are wrapped correctly per version — `{"d":{"results":[…],"__count":"N"}}`
with `__metadata` for V2, `{"value":[…],"@odata.count":N}` for V4.

### Data sources

| Mode | Behaviour |
|---|---|
| `faker` | Schema-driven, seeded per collection so rows are stable across restarts. Field-name aware: `*Email` gets an email, `*Amount` a price, `*ID` a zero-padded SAP-style key. |
| `fixture` | Upload JSON (array, `{rows:[…]}`, `{value:[…]}`, `{d:{results:[…]}}`) or CSV. |
| `ai` | Generate rows with Ollama or Claude, once, then cached. |
| `proxy` | Forward to a real backend and record the exchange. |

Per-mock knobs: **latency** and **error rate**, so you can exercise the retry
and exception branches of an IFlow instead of only the happy path.

Datasets are generated **once** and stored. A mock that invented new rows on
every call would make test assertions meaningless.

---

## 3. Test runner

Generates one request per operation, fills path/query/body from the spec (using
declared examples first), fires it, and checks:

- the status code is one the specification declares
- the response body validates against that response's schema (Ajv, with the
  OData envelope unwrapped first)

For operations addressing a single entity it reads a real key from the
collection first, rather than inventing one that would always 404.

```bash
node dist/cli/test.js --mock hubcat              # exits non-zero on failure
node dist/cli/test.js --mock hubcat --read-only  # skip writes
node dist/cli/test.js --spec 3 --target https://tenant.example.com/path --read-only
```

`--read-only` is what you want when pointing at a real tenant.

---

## 4. Traffic inspector

Every call to `/mock` is captured: method, path, query, request and response
headers, both payloads, status, byte counts, duration, which operation matched,
and the client IP. Admin API calls are not logged — they would put the
sandbox's own secrets in the log. The Network tab streams them live over a WebSocket
and shows a detail pane per request.

`Authorization`, `Cookie` and similar headers are redacted before storage.
Bodies over `TRAFFIC_MAX_BODY` are truncated; the log self-trims to
`TRAFFIC_MAX_ROWS`.

This is the piece that answers "what exactly did my IFlow send?" — including
malformed JSON, which is logged byte for byte and answered with a 400, the way
a real service would.

---

## Admin API

All routes take `X-Sandbox-Key` when `ADMIN_KEY` is set.

```
GET    /api/status                                 counts, last run, AI provider health
POST   /api/sync                {filter,fetchSpecs}   starts a crawl (progress over /ws)
GET    /api/runs                                   sync history
GET    /api/runs/:id/changes                       changes for one run
GET    /api/runs/:id/report                        rendered HTML report
GET    /api/packages | /api/artifacts              catalog queries
POST   /api/specs/import        multipart or {text} import a specification
GET    /api/specs | /api/specs/:id/parsed          stored specs, normalised view
GET    /api/mocks                                  list
POST   /api/mocks               {specId,slug,…}    mount
PATCH  /api/mocks/:id                              strategy, latency, error rate, rows
DELETE /api/mocks/:id
GET    /api/mocks/:id/collections
GET    /api/mocks/:id/datasets/:collection
PUT    /api/mocks/:id/datasets/:collection         fixture upload (JSON or CSV)
POST   /api/mocks/:id/datasets/:collection/ai      regenerate with the AI provider
POST   /api/tests/run           {mockId,readOnly}
GET    /api/tests/runs | /api/tests/runs/:id
GET    /api/traffic | /api/traffic/:id
DELETE /api/traffic
GET    /api/update                                 installed and latest version
POST   /api/update/check                           ask GitHub now
POST   /api/update/apply                           install the latest release (stand-alone installs)
```

The live feed is a WebSocket at `/ws`. Browsers cannot put headers on a
WebSocket, so the key goes in a subprotocol: offer `sandbox` plus
`key.<base64url of ADMIN_KEY>`.

---

## Layout

```
src/
  config.ts              .env loading
  db/                    schema.sql + node:sqlite wrapper
  hub/                   catalog client, sync orchestration, diff engine, reports
  spec/                  OpenAPI 3 / Swagger 2 / EDMX → one normalised model
  mock/                  faker, OData query engine, dataset store, request router
  ai/                    provider interface + Ollama and Claude implementations
  testrunner/            request generation and Ajv response validation
  inspector/             traffic recorder middleware
  api/                   admin REST routes
  net/                   CIDR allow-list, admin-key and same-origin checks
  update/                release check and self-update trigger
  cli/                   sync.js and test.js entry points
public/                  UI (no bundler — plain ES modules)
install/                 stand-alone installers and the sapbah control script
deploy/                  systemd units, install.sh, REACHABILITY.md
data/                    SQLite file, reports, specs  (git-ignored)
```

---

## Known limits

- **Spec downloads need a Hub session.** Catalog tracking does not. Manual
  import always works.
- `$expand` is accepted but not resolved — expanded navigation properties are
  not inlined.
- The OData `$filter` parser covers the operators listed above. Anything it
  cannot parse passes every row through rather than erroring, so an
  unsupported filter shows up as "too many results", and the exact expression
  is visible in the traffic log.
- `node:sqlite` is still marked experimental in Node. The systemd units set
  `NODE_OPTIONS=--disable-warning=ExperimentalWarning` to silence the notice.
- A full-catalog crawl detects removals; a filtered crawl does not, since it
  cannot tell "gone" from "filtered out".
- Write operations in a full test run mutate the mock's dataset (a DELETE test
  really deletes). Use `--read-only`, or reset the dataset from the UI.

---

## Verified against

Built and exercised on Node 24 with the Hub's own catalog `$metadata` as the
test specification: 46 entity sets, 231 generated operations, **230/230 tests
passing**, and live syncs against `api.sap.com` (1948 packages / 42,073
artifacts unfiltered; 141 / 641 filtered), including version-change detection
across runs.

The Windows stand-alone installer was run end to end on Windows 11: runtime
download and checksum check, build, autostart registration, LAN reachability,
admin-key enforcement, restart cycle, and a clean uninstall. The macOS and
Linux installer is syntax-checked and its runtime resolution verified for
darwin-arm64, darwin-x64, linux-x64 and linux-arm64. CI runs all three
installers for real on every push (Windows, Ubuntu and macOS runners,
`--no-service`); the autostart registration on macOS and Linux has not been
exercised on a real desktop yet — worth a first run with `--no-service` so you
can see each step before it registers anything.

---

## Support the project

SAP BAH Sandbox is free and MIT-licensed. If it saves you time, you can buy me
a coffee: **[paypal.me/bellizia](https://paypal.me/bellizia)**.

Bug reports and pull requests are welcome in
[Issues](https://github.com/bdbais/sap-bah-sandbox/issues).

## License

[MIT](LICENSE) © 2026 Bais — [bais.info](https://bais.info)
