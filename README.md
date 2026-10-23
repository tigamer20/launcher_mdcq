# ModdedQC Launcher

Custom Minecraft launcher + admin website for the **ModdedQC** Paper server.

- **Launcher (players):** log in with Microsoft, click **JOUER**. The launcher installs the right Minecraft version and Java, downloads the extra files you publish (resource packs, `options.txt`...), and connects straight to the server. It shows the news, the live player count and the maintenance message.
- **Admin website (staff):** live server status, plugin management, RCON console, news, maintenance mode, and player files. Changes show up in every launcher within 15 seconds.

Plugins stay on the Paper server: players run normal (vanilla) Minecraft, matching the Paper version.

Only `electron` and `electron-builder` are used. The admin website has no dependencies (plain Node.js).

## Project layout

```
launcher.config.json     <- URL of the admin website + Azure client ID
src/main/main.js         <- launcher window + buttons wiring
src/main/auth.js         <- Microsoft / Xbox / Minecraft login
src/main/sync.js         <- downloads the player files published on the website
src/main/minecraft.js    <- installs and starts Minecraft
src/main/status.js       <- live server status (players online, version)
src/renderer/            <- launcher UI (HTML / CSS / JS)
admin-panel/server.js    <- admin website + file server for the launcher
admin-panel/rcon.js      <- sends commands to the Paper server
admin-panel/public/      <- admin website UI
tools/build-manifest.js  <- builds manifest.json (used by the website, also works alone)
```

## 1. Run the admin website

On the machine that runs Paper (needed for the Plugins tab):

```bash
ADMIN_PASSWORD='a-long-password' \
PAPER_DIR=/home/minecraft/paper \
RCON_PASSWORD='same-as-server.properties' \
node admin-panel/server.js
```

| Variable         | Required | What it does                                                                          |
| ---------------- | -------- | ------------------------------------------------------------------------------------- |
| `ADMIN_PASSWORD` | yes      | Password for the website (8+ characters).                                             |
| `PORT`           | no       | Website port (default `8080`).                                                        |
| `DATA_DIR`       | no       | Where news, settings and player files are stored (default `admin-panel/data`).        |
| `PAPER_DIR`      | no       | Paper folder (the one with `plugins/`). Turns on the **Plugins** tab.                 |
| `RCON_PASSWORD`  | no       | Turns on the **Console** and makes maintenance close the server with the whitelist.   |
| `RCON_HOST/PORT` | no       | Default `127.0.0.1` / `25575`.                                                        |

In Paper's `server.properties`:

```properties
enable-rcon=true
rcon.password=same-as-RCON_PASSWORD
enforce-whitelist=true     # kicks non-whitelisted players when maintenance starts
```

Don't open the RCON port (25575) in your firewall: the website talks to it locally.
Put the website behind HTTPS (Caddy, nginx, Cloudflare Tunnel...) before using it over the internet.

### What each tab does

| Tab                  | Effect                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| **Tableau de bord**  | Online/offline, players, Paper version, active plugins. **Maintenance** switch + message.        |
| **Serveur**          | Name, subtitle, address, Minecraft version (same as Paper), auto-connect.                        |
| **Plugins**          | Upload/update a `.jar`, enable/disable (renames to `.jar.disabled`), delete. Applies after a restart. |
| **Console**          | Runs server commands through RCON (`list`, `say ...`, `whitelist add ...`...).                    |
| **Nouvelles**        | News shown in the launcher.                                                                      |
| **Fichiers joueurs** | Files copied into every player's Minecraft folder (resource packs, `options.txt`...).             |

**Maintenance mode** blocks the JOUER button in every launcher and shows your message. With RCON, it also runs `whitelist on` (and `whitelist off` when you turn it off), so people using the official launcher can't join either. Staff on the whitelist can still connect.

## 2. Microsoft login (Azure)

Microsoft requires every launcher to have its own app ID:

1. Go to <https://portal.azure.com> → **App registrations** → **New registration**.
2. Supported account types: **Personal Microsoft accounts only**.
3. Redirect URI: platform **Public client/native (mobile & desktop)**, value `https://login.microsoftonline.com/common/oauth2/nativeclient`.
4. Copy the **Application (client) ID** into `azureClientId` in `launcher.config.json`.
5. Ask Microsoft to allow your app to use the Minecraft API: <https://aka.ms/mce-reviewappid>. Until it's approved, login fails with "Connexion aux serveurs Minecraft impossible".

## 3. Build the launcher

Set `serverUrl` in `launcher.config.json` to the admin website's public URL (for example `https://admin.moddedqc.ca/`), then:

```bash
npm install
npm start          # run in development
npm run dist       # build the installer (.exe on Windows, .dmg on macOS, .AppImage on Linux)
```

To test against a local website without editing the config: `MODDEDQC_SERVER_URL=http://localhost:8080/ npm start`.

## Where files go on the player's PC

Game files are stored in `%APPDATA%\.moddedqc` (Windows), `~/Library/Application Support/.moddedqc` (macOS) or `~/.config/.moddedqc` (Linux). The **Paramètres** menu has a button that opens this folder and a slider to set RAM. The game output is written to `logs/launcher-latest.log`.
