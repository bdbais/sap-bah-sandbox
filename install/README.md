# Stand-alone install

One command per platform. Each installer downloads its own Node runtime, builds
the app against it, and puts everything in a single self-contained folder.

**Nothing is installed system-wide.** If the machine has no Node — or has an old
or company-managed one — it does not matter and is not touched.

---

## Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\install\install.ps1
```

Installs to `%LOCALAPPDATA%\SapBahSandbox`, registers a Task Scheduler entry
that starts it at logon, and launches it. No administrator rights needed.

## macOS

```bash
./install/install.sh
```

Installs to `~/Applications/SapBahSandbox` and registers a launchd agent that
starts it at login. No `sudo` needed.

## Linux

```bash
./install/install.sh
```

Installs to `~/.local/share/sap-bah-sandbox` and registers a `systemd --user`
service, enabling lingering so it survives logout. No `sudo` needed.

> `xz-utils` must be present to unpack the Linux runtime
> (`sudo apt install -y xz-utils` / `sudo dnf install -y xz`). The installer
> checks and tells you if it is missing.

### Options (all platforms)

| Option | Effect |
|---|---|
| `-Dir <path>` / `--dir <path>` | Install somewhere else |
| `-NoService` / `--no-service` | Skip autostart; just run it manually |
| `-Offline` / `--offline` | Use a runtime already cached in `.cache/` |

---

## Using it

A control script lands in the install folder:

```bash
sapbah start | stop | restart | status
sapbah logs                     # follow the log
sapbah open                     # open the UI in a browser
sapbah sync --filter SuccessFactors
sapbah test --mock hubcat --read-only
sapbah service install|uninstall
```

On Windows it is `sapbah.cmd` with the same commands.

Put it on your PATH if you like:

```bash
ln -sf ~/Applications/SapBahSandbox/sapbah /usr/local/bin/sapbah   # macOS
ln -sf ~/.local/share/sap-bah-sandbox/sapbah ~/.local/bin/sapbah   # Linux
```

---

## What gets installed

```
<install-dir>/
  sapbah  (or sapbah.cmd + sapbah.ps1)   control script
  runtime/                               private Node 24 LTS
  app/                                   compiled app + production deps
  data/                                  SQLite database, reports, logs
  .env                                   config, with a generated ADMIN_KEY
```

`ADMIN_KEY` is generated at install time and printed once. It protects the
`/api` routes; paste it into the **key** box at the top right of the UI. The
mock endpoints under `/mock` are deliberately *not* key-protected, since the
whole point is for other systems to call them.

---

## Upgrading

Re-run the same installer. It replaces `runtime/` and `app/` and **keeps your
`data/` and `.env`**.

## Uninstalling

```powershell
powershell -ExecutionPolicy Bypass -File .\install\uninstall.ps1          # Windows
```
```bash
./install/uninstall.sh                                                   # macOS / Linux
```

Removes the autostart entry, stops the process, and deletes the app and
runtime — but keeps `data/` and `.env`. Add `-Purge` / `--purge` to delete
those too.

---

## Which install should I use?

| You want | Use |
|---|---|
| A sandbox on your own laptop | this stand-alone installer |
| A shared box the whole team points CPI at | [../deploy/install.sh](../deploy/install.sh) — system-wide systemd, dedicated service user, starts at boot without anyone logging in |

The two are independent; the stand-alone install never touches `/opt` or
system systemd.

---

## Notes

- **Firewall.** On first start Windows may ask whether to allow it. Allow it on
  private networks so other machines can reach the mocks. To open the port by
  hand: `netsh advfirewall firewall add rule name="SAP BAH Sandbox" dir=in action=allow protocol=TCP localport=8080`
- **Port.** Change `PORT` in `.env`, then `sapbah restart`.
- **Reaching it from an SAP CPI tenant** needs more than a LAN address — see
  [../deploy/REACHABILITY.md](../deploy/REACHABILITY.md).
- **PowerShell scripts are pure ASCII on purpose.** Windows PowerShell 5.1
  reads a BOM-less `.ps1` as Windows-1252, and a UTF-8 em dash decodes to bytes
  that include a curly quote — which PowerShell accepts as a string delimiter,
  silently corrupting the parse. If you edit them, keep them ASCII.
