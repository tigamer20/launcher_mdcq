# ModdedQC Launcher

Custom Minecraft launcher + admin website for the **ModdedQC** Paper server.

```
 Players' PCs                    Render (internet)                  Your Paper PC / VPS
┌──────────────────┐  news,     ┌──────────────────────┐  signed   ┌──────────────────────┐
│ ModdedQC Launcher│◄───────────│ Admin website        │──────────►│ paper-agent          │
│ (ModdedQC-Setup  │ maintenance│ admin-panel/         │ requests  │  ├─ plugins/ folder  │
│  .exe)           │ files      │                      │           │  └─ RCON (local)     │
└────────┬─────────┘            └──────────────────────┘           │ Paper server         │
         └──────────────────── plays on ──────────────────────────►└──────────────────────┘
```

- **Launcher (players):** install `ModdedQC-Setup.exe`, log in with Microsoft, click **JOUER**. It installs the right Minecraft version and Java, downloads the files you publish (resource packs, `options.txt`...) and connects straight to the server. It shows the news, the player count and the maintenance message.
- **Admin website (staff, on Render):** live server status, plugins, console, news, maintenance mode and player files. Changes show up in every launcher within 15 seconds.
- **Agent (on the Paper machine):** a tiny program that lets the website manage plugins and send console commands. It only accepts requests signed with your secret.

Plugins stay on the Paper server: players run normal (vanilla) Minecraft, matching the Paper version.

## Download (players)

**<https://github.com/tigamer20/launcher_mdcq/releases/latest/download/ModdedQC-Setup.exe>**

Open the file and follow the installer. It creates a **ModdedQC** shortcut on the desktop and in the Start menu.

> Windows may show "Windows protected your PC" because the installer isn't signed with a paid certificate. Click **More info** → **Run anyway**.

---

## Setup (staff), in this order

### 1. Microsoft login (Azure app)

Microsoft requires every launcher to have its own app ID:

1. Go to <https://portal.azure.com> → **App registrations** → **New registration**.
2. Supported account types: **Personal Microsoft accounts only**.
3. Redirect URI: platform **Public client/native (mobile & desktop)**, value `https://login.microsoftonline.com/common/oauth2/nativeclient`.
4. Keep the **Application (client) ID**: you need it in step 4.
5. Ask Microsoft to allow your app to use the Minecraft API: <https://aka.ms/mce-reviewappid>. Until it's approved, login fails with "Connexion aux serveurs Minecraft impossible".

### 2. Host the website on Render

This repository contains a `render.yaml` file, so Render sets everything up for you. No separate repository is needed.

1. Create a secret for the agent (a long random password). On any PC with Node.js:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Keep it: it goes both on Render and on the Paper PC.
2. On <https://dashboard.render.com>: **New** → **Blueprint** → connect GitHub and pick `tigamer20/launcher_mdcq` → **Apply**.
3. Render asks for 3 values:
   | Variable         | Value                                                                   |
   | ---------------- | ----------------------------------------------------------------------- |
   | `ADMIN_PASSWORD` | Password to log in to the website (8+ characters).                      |
   | `AGENT_SECRET`   | The secret from step 1.                                                 |
   | `AGENT_URL`      | Address of the agent from step 3, e.g. `http://203.0.113.10:8765/`. You can leave it empty for now and add it later in **Environment**. |
4. Wait for the deploy to finish. Your website is at `https://moddedqc-admin.onrender.com/admin/` (Render shows the exact URL; you can add your own domain in **Settings** → **Custom Domains**).

**Cost:** the Blueprint uses the **Starter** plan (about 7 US$/month) with a 1 GB disk (about 0.25 US$/month). The disk is what keeps your news, settings and player files. On the free plan, Render erases files on every restart and puts the site to sleep, so launchers would wait up to a minute.

Every push to `main` that changes the website redeploys it automatically.

### 3. Install the agent on the Paper PC/VPS

1. Install **Node.js 22 LTS** from <https://nodejs.org>.
2. Copy the `paper-agent/` folder from this repository to that machine (for example next to your Paper folder).
3. In Paper's `server.properties`:
   ```properties
   enable-rcon=true
   rcon.password=choose-a-password
   enforce-whitelist=true     # kicks non-whitelisted players when maintenance starts
   ```
   Restart Paper. **Don't** open the RCON port (25575) on your router: only the agent uses it, locally.
4. Start the agent:
   - **Windows:** copy `start-agent.example.bat` to `start-agent.bat`, fill in the 3 values, double-click it. Keep the window open.
   - **Linux:**
     ```bash
     AGENT_SECRET=... PAPER_DIR=/home/minecraft/paper RCON_PASSWORD=... node paper-agent/agent.js
     ```
     (to start it automatically, create a systemd service with these `Environment=` lines.)
5. Make the agent reachable from Render, like you did for Minecraft's port 25565:
   - **Router:** forward TCP port **8765** to this PC, and allow it in the Windows firewall. Then `AGENT_URL` is `http://YOUR-PUBLIC-IP:8765/`.
   - **Or Cloudflare Tunnel** (free, no router changes, encrypted with HTTPS) if you have a domain on Cloudflare: point a tunnel at `http://localhost:8765` and use `https://agent.your-domain.com/` as `AGENT_URL`.
6. Put that address in `AGENT_URL` on Render (**Environment** tab). The **Plugins** and **Console** tabs appear on the website.

Every request from the website is signed with the secret, expires after 60 seconds and can't be reused, so nobody else can control the agent even if they find the port. With the router option, plugin files and console output travel unencrypted; use Cloudflare Tunnel if that matters to you. The agent needs the PC's clock to be correct (automatic time is on by default).

| Agent variable   | Required | Meaning                                                    |
| ---------------- | -------- | ---------------------------------------------------------- |
| `AGENT_SECRET`   | yes      | Same value as on Render (32+ characters).                  |
| `PAPER_DIR`      | yes      | Paper folder (the one containing `plugins/`).              |
| `RCON_PASSWORD`  | no       | Same as `rcon.password`. Enables the console + whitelist.  |
| `AGENT_PORT`     | no       | Default `8765`.                                            |
| `RCON_HOST/PORT` | no       | Default `127.0.0.1` / `25575`.                             |

### 4. Build the Windows installer (.exe)

The installer is built by GitHub (on a Windows machine) with `.github/workflows/release.yml`:

1. In the GitHub repository: **Settings** → **Secrets and variables** → **Actions** → **Variables** tab → add:
   - `SERVER_URL` = your Render URL, e.g. `https://moddedqc-admin.onrender.com/`
   - `AZURE_CLIENT_ID` = the ID from step 1
2. **Releases** → **Draft a new release** → **Choose a tag** → type `v1.0.0` → **Publish release**.
3. About 5 minutes later, `ModdedQC-Setup.exe` is attached to the release, and the download link above works.

For an update, publish a new release with a higher number (`v1.0.1`...). The download link always points to the newest one. You can also build without publishing: **Actions** → **Build Windows installer** → **Run workflow**, then download it from the run's **Artifacts**.

---

## Using the admin website

| Tab                  | Effect                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| **Tableau de bord**  | Online/offline, players, Paper version, active plugins. **Maintenance** switch + message.            |
| **Serveur**          | Name, subtitle, address, Minecraft version (same as Paper), auto-connect.                            |
| **Plugins**          | Upload/update a `.jar`, enable/disable (renames to `.jar.disabled`), delete. Applies after a restart. |
| **Console**          | Runs server commands (`list`, `say ...`, `whitelist add ...`...).                                     |
| **Nouvelles**        | News shown in the launcher.                                                                          |
| **Fichiers joueurs** | Files copied into every player's Minecraft folder (resource packs, `options.txt`...).                |

**Maintenance mode** blocks the JOUER button in every launcher and shows your message. Through the agent it also runs `whitelist on` (and `whitelist off` afterwards), so people using the official launcher can't join either. Staff on the whitelist can still connect.

## Development

```bash
npm install
ADMIN_PASSWORD=devpassword node admin-panel/server.js          # website on http://localhost:8080/admin/
MODDEDQC_SERVER_URL=http://localhost:8080/ npm start            # launcher pointed at it
```

Game files are stored in `%APPDATA%\.moddedqc` (Windows), `~/Library/Application Support/.moddedqc` (macOS) or `~/.config/.moddedqc` (Linux). The game output is written to `logs/launcher-latest.log` there.

```
src/main/            launcher: window, Microsoft login, file sync, Minecraft install/launch, server status
src/renderer/        launcher UI
admin-panel/         admin website (no dependencies)
paper-agent/         agent for the Paper machine (no dependencies)
tools/               manifest builder + CI helper
build/icon.png       app icon
render.yaml          Render Blueprint
.github/workflows/   builds ModdedQC-Setup.exe
```
