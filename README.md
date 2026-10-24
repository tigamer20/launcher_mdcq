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

Open the file and follow the installer. It creates a **ModdedQC** shortcut on the desktop and in the Start menu. After that, the launcher updates itself.

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

**Cost: free.** Render's free plan erases the website's files on every restart, so the website keeps its data (server address, news, maintenance, beta key, player files) in the **`admin-data` branch of this repository**: it restores everything from there at startup and saves every change there right away. This needs `GITHUB_TOKEN` (see "Server file editor" below, the same token is used).
- The beta key is only stored as a SHA-256 fingerprint, never in clear text (the repository is public).
- Player files must be under 95 MB each (GitHub limit).
- On the free plan the site goes to sleep after 15 minutes without visits: the first launcher to open after that waits up to about a minute while it wakes up.

Every push to `main` that changes the website redeploys it automatically.

**Created the service by hand (New → Web Service) instead of the Blueprint?** Use these settings:

| Setting            | Value                        |
| ------------------ | ---------------------------- |
| Runtime / Language | Node                         |
| Build Command      | `node --version`             |
| Start Command      | `node admin-panel/server.js` |
| Health Check Path  | `/healthz`                   |
| Instance type      | Free                         |
| Environment        | `NODE_VERSION` = `22`, `TRUST_PROXY` = `1`, plus `ADMIN_PASSWORD`, `AGENT_SECRET`, `AGENT_URL`, `GITHUB_TOKEN` |

### 3. Install the agent on the Paper machine (Mac, Windows or Linux)

1. Install **Node.js 22 LTS** from <https://nodejs.org> (on a Mac, take the **macOS Installer (.pkg)**).
2. Copy the `paper-agent/` folder from this repository to that machine (for example next to your Paper folder).
3. In Paper's `server.properties`:
   ```properties
   enable-rcon=true
   rcon.password=choose-a-password
   enforce-whitelist=true     # kicks non-whitelisted players when maintenance starts
   ```
   Restart Paper. **Don't** open the RCON port (25575) on your router: only the agent uses it, locally.
4. Start the agent:
   - **Mac:** in the `paper-agent` folder, duplicate `start-agent.example.command` and rename the copy `start-agent.command`. Open it with TextEdit and fill in the 3 values (`PAPER_DIR` is the folder containing `server.jar` and `plugins/`; drag that folder into a Terminal window to see its path). Then double-click `start-agent.command`.
     - The first time, macOS may refuse to open it: **right-click** → **Open** → **Open**.
     - If macOS asks "Do you want the application node to accept incoming network connections?", click **Allow**.
     - Keep the Terminal window open. The script keeps the Mac awake while it runs.
     - To start it automatically: **System Settings** → **General** → **Login Items** → **+** → choose `start-agent.command`.
     - Also set **System Settings** → **Energy** (or **Battery** → **Options**) → **Prevent automatic sleeping when the display is off**, so Paper keeps running too.
   - **Windows:** copy `start-agent.example.bat` to `start-agent.bat`, fill in the 3 values, double-click it. Keep the window open.
   - **Linux:**
     ```bash
     AGENT_SECRET=... PAPER_DIR=/home/minecraft/paper RCON_PASSWORD=... node paper-agent/agent.js
     ```
     (to start it automatically, create a systemd service with these `Environment=` lines.)
5. Make the agent reachable from Render, like you did for Minecraft's port 25565:
   - **Router:** forward TCP port **8765** to this machine (same as you did for 25565). On a Mac, its local IP is in **System Settings** → **Network** → **Wi-Fi** or **Ethernet** → **Details**. On Windows, also allow the port in the firewall. Then `AGENT_URL` is `http://YOUR-PUBLIC-IP:8765/` (your public IP: <https://ifconfig.me>).
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

### 4. Publish the launcher (and its updates)

The installer is built by GitHub (on a Windows machine) with `.github/workflows/release.yml`.

**Once:** in the GitHub repository, **Settings** → **Secrets and variables** → **Actions** → **Variables** tab → add:
- `SERVER_URL` = your Render URL, e.g. `https://moddedqc-admin.onrender.com/`
- `AZURE_CLIENT_ID` = the ID from step 1

**Every time you want to release a version**, push to `main` with a commit message that contains:

```
[off_update] [1.2.0] Short description of what changed
```

```bash
git commit -m "[off_update] [1.2.0] Nouveau bouton Paramètres"
git push origin main
```

(On github.com, type the same thing in the **Commit message** box when you edit a file or merge a pull request.)

What happens next, automatically:
1. GitHub builds `ModdedQC-Setup.exe` with version **1.2.0** (about 5 minutes; follow it in the **Actions** tab), plus the list of the launcher's files with their fingerprint (`app-update.json`).
2. It publishes release **v1.2.0** on the Releases page, with the rest of your commit message as release notes.
3. When a player opens the launcher, a small update window (like Discord's) checks GitHub, sees 1.2.0 is newer and downloads **only the files that changed**. It shows the version, size downloaded / total, speed, time remaining and how many files changed. Then it checks the files and restarts on the new version. Nothing to install. The version is shown next to the logo (`v1.2.0`).
   - The full installer is only downloaded when the Electron runtime itself changes (when `electron` is upgraded in `package.json`).
   - If a new version crashes twice at startup, the launcher goes back to the previous one by itself.

Rules:
- The version must be higher than the last one (`1.2.0` → `1.2.1`, `1.3.0` or `2.0.0`). Otherwise the build stops with an explanation.
- Commits without `[off_update]` don't create a release (website and code changes are still pushed normally).
- `[off_update] 1.2.0` without the second brackets and `[off_update] [v1.2.0]` also work.

You can also release by hand: **Actions** → **Release launcher** → **Run workflow** → type the version.

---

## Using the admin website

| Tab                  | Effect                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| **Tableau de bord**  | Online/offline, players, Paper version, active plugins. **Maintenance** switch + message.            |
| **Serveur**          | Name, subtitle, address, Minecraft version (same as Paper), auto-connect.                            |
| **Plugins**          | Upload/update a `.jar`, enable/disable (renames to `.jar.disabled`), delete. Applies after a restart. |
| **Fichiers du serveur** | Edit the Paper server's text files (configs) on the Mac. Each save is also committed to GitHub (see below). |
| **Console**          | Runs server commands (`list`, `say ...`, `whitelist add ...`...).                                     |
| **Nouvelles**        | News shown in the launcher.                                                                          |
| **Fichiers joueurs** | Files copied into every player's Minecraft folder (resource packs, `options.txt`...).                |

**Maintenance mode** blocks the JOUER button in every launcher and shows your message. Through the agent it also runs `whitelist on` (and `whitelist off` afterwards), so people using the official launcher can't join either. Staff on the whitelist can still connect.

### Beta versions (dev) for testers

Dev versions (`[dev_update] [x.y.z]`, or **Version dev** in the merge window) are published as pre-releases `vx.y.z-dev`. Normal launchers ignore them. To let testers get them:

1. On the website, **Serveur** tab → **Clé bêta** → type a key or click **Générer**, then **Enregistrer**. Give that key to your testers. Changing it (or emptying it) removes access for everyone.
2. In the launcher, the tester presses **Ctrl+Shift+D**: a **DEV** button appears next to the settings (it stays until they press Ctrl+Shift+D again).
3. In **DEV** → **Mises à jour bêta**: they paste the key, click **Valider**, then tick **Activer les mises à jour bêta**.
4. When a dev version newer than the official one comes out, the update window asks: **Installer la bêta** or **Rester sur la version publique** (it won't ask again for that version). The next official version replaces the beta automatically.

The key decides who is *offered* beta updates in the launcher. The repository is public, so the dev installers on the Releases page can still be downloaded by anyone who finds them.

### Server file editor → GitHub → new version

The **Fichiers du serveur** tab browses the Paper folder on the Mac (through the agent) and edits text files: `.yml`, `.properties`, `.json`, `.toml`, `.txt`... Jars and worlds can't be edited there.

1. **Enregistrer** (or Cmd/Ctrl+S) writes the file on the Mac right away **and** commits it to the `admin-website` branch, in the `paper-server/` folder of this repository.
   The repository is public, so **values that look like passwords, tokens or keys are replaced by `********`** in the commit (e.g. `rcon.password`, `mysql.password`, `bot-token`). The real values stay only on the Mac.
2. **Fusionner dans main** opens a window: choose **Version dev** or **Version officielle**, look at the current versions shown above the box, type the new version, then **Confirmer la fusion**.
   The website opens a pull request `admin-website` → `main` and merges it immediately, with the title:
   - `[off_update] [x.y.z] ...` for an official version: release `vx.y.z`, **every launcher updates**;
   - `[dev_update] [x.y.z] ...` for a dev version: pre-release `vx.y.z-dev` on the Releases page for testing, **launchers don't update**.

   The version must be higher than the current official version. Paper itself applies config changes after a restart (or the plugin's reload command in **Console**).

**Setup (once):** create a GitHub token that can only touch this repository:
1. GitHub → your picture → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. **Repository access** → **Only select repositories** → `launcher_mdcq`.
3. **Permissions** → **Contents: Read and write** and **Pull requests: Read and write**.
4. Copy the token into `GITHUB_TOKEN` on Render (**Environment** tab).

## Development

```bash
npm install
ADMIN_PASSWORD=devpassword node admin-panel/server.js          # website on http://localhost:8080/admin/
MODDEDQC_SERVER_URL=http://localhost:8080/ npm start            # launcher pointed at it
```

Game files are stored in `%APPDATA%\.moddedqc` (Windows), `~/Library/Application Support/.moddedqc` (macOS) or `~/.config/.moddedqc` (Linux). The game output is written to `logs/launcher-latest.log` there.

```
src/main/            launcher: window, Microsoft login, file sync, Minecraft install/launch, server status, self-update
src/renderer/        launcher UI
admin-panel/         admin website (no dependencies)
paper-agent/         agent for the Paper machine (no dependencies)
tools/               manifest builder + release helpers
build/icon.png       app icon
render.yaml          Render Blueprint
.github/workflows/   builds ModdedQC-Setup.exe
```
