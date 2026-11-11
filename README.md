# ATM Launcher

Custom Minecraft launcher + admin website for the **ATM** server (All the Mod · Saison 3, based on All the Mods 10).

```
 Players' PCs                    Render (internet)                  Server PC (Windows)
┌──────────────────┐  news,     ┌──────────────────────┐  signed   ┌──────────────────────┐
│ ATM Launcher     │◄───────────│ Admin website        │──────────►│ paper-agent          │
│ (ATM-Setup.exe)  │ maintenance│ admin-panel/         │ requests  │  ├─ plugins/ folder  │
│                  │ files      │                      │           │  └─ RCON (local)     │
└────────┬─────────┘            └──────────────────────┘           │ Minecraft server     │
         └──────────────────── plays on ──────────────────────────►└──────────────────────┘
```

- **Launcher (players):** install `ATM-Setup.exe`, log in with Microsoft, click **JOUER**. It installs the right Minecraft version and Java, downloads the files you publish (resource packs, `options.txt`...) and connects straight to the server. It shows the news, the player count and the maintenance message.
- **Admin website (staff, on Render):** live server status, plugins, console, news, maintenance mode and player files. Changes show up in every launcher within 15 seconds.
- **Agent (on the server's PC):** a tiny program that lets the website manage the server's mods (NeoForge) or plugins (Paper), edit its files and send console commands. It only accepts requests signed with your secret.

Plugins stay on the Paper server: players run normal (vanilla) Minecraft, matching the Paper version.

## Download (players)

**<https://github.com/tigamer20/launcher_mdcq/releases/latest/download/ATM-Setup.exe>**

Open the file and follow the installer. It creates an **ATM** shortcut on the desktop and in the Start menu. After that, the launcher updates itself.

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
4. Wait for the deploy to finish. Your website is at `https://atm-admin.onrender.com/admin/` (Render shows the exact URL; you can add your own domain in **Settings** → **Custom Domains**).

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

### 3. Install the agent on the server machine (Windows, Mac or Linux)

> **All the Mod · Saison 3 runs on a Windows PC.** On Windows: use `start-agent.example.bat` (copy it to `start-agent.bat`), set `SERVER_DIR` to the **server** folder (the NeoForge server of All the Mods 10, with `server.properties` and `mods/`), allow **Node.js** when Windows Defender Firewall asks, forward port **8765** on the router to this PC, and in **Settings → System → Power** set sleep to **Never**, so the server and the agent stay reachable. The agent detects NeoForge by itself: the website's **Mods du serveur** tab then manages the server's `mods/` folder (on a Paper server it manages `plugins/`). Older setups with `PAPER_DIR` keep working.


1. Install **Node.js 22 LTS** from <https://nodejs.org> (on a Mac, take the **macOS Installer (.pkg)**).
2. Copy the `paper-agent/` folder from this repository to that machine (for example next to your Paper folder).
3. In the server's `server.properties`:
   ```properties
   enable-rcon=true
   rcon.password=choose-a-password
   enforce-whitelist=true     # kicks non-whitelisted players when maintenance starts
   ```
   Restart the server. **Don't** open the RCON port (25575) on your router: only the agent uses it, locally.
4. Start the agent:
   - **Mac:** in the `paper-agent` folder, duplicate `start-agent.example.command` and rename the copy `start-agent.command`. Open it with TextEdit and fill in the 3 values (`SERVER_DIR` is the server folder, with `server.properties`; drag that folder into a Terminal window to see its path). Then double-click `start-agent.command`.
     - The first time, macOS may refuse to open it: **right-click** → **Open** → **Open**.
     - If macOS asks "Do you want the application node to accept incoming network connections?", click **Allow**.
     - Keep the Terminal window open. The script keeps the Mac awake while it runs.
     - To start it automatically: **System Settings** → **General** → **Login Items** → **+** → choose `start-agent.command`.
     - Also set **System Settings** → **Energy** (or **Battery** → **Options**) → **Prevent automatic sleeping when the display is off**, so Paper keeps running too.
   - **Windows:** copy `start-agent.example.bat` to `start-agent.bat`, fill in the 3 values, double-click it. Keep the window open.
   - **Linux:**
     ```bash
     AGENT_SECRET=... SERVER_DIR=/home/minecraft/server RCON_PASSWORD=... node paper-agent/agent.js
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
| `SERVER_DIR`     | yes      | Server folder (with `server.properties`). `PAPER_DIR` also works. |
| `SERVER_TYPE`    | no       | `neoforge` or `paper`, only if the detection is wrong.     |
| `RCON_PASSWORD`  | no       | Same as `rcon.password`. Enables the console + whitelist.  |
| `AGENT_PORT`     | no       | Default `8765`.                                            |
| `RCON_HOST/PORT` | no       | Default `127.0.0.1` / `25575`.                             |

### Publish the modpack (All the Mod · Saison 3)

The launcher installs **NeoForge** and a **custom modpack based on All the Mods 10** (Minecraft 1.21.1).

**Recommended: the modpack editor of the admin website** (no PC needs to be on)

1. **Once:** get a free CurseForge API key (https://console.curseforge.com → API Keys) and add it on Render as `CURSEFORGE_API_KEY` (`GITHUB_TOKEN` must be set too).
2. In the CurseForge app: your profile → **⋮** → **Export Profile**. Tick `config`, `kubejs`, `defaultconfigs` and the other folders you changed, **but not `mods`**: the export then only lists the mods, so it stays small.
3. Admin website → **Modpack** → **Importer un export CurseForge (.zip)**. The website finds every mod on CurseForge and stores the configurations on GitHub.
4. Change what you want:
   - **Mods**: add one by pasting its CurseForge link, choose another **Version**, **Désactiver** or **Retirer** it, or upload a `.jar`. A few authors forbid other apps from downloading their mod: those show **À téléverser**, download the `.jar` from their CurseForge page and upload it (publishing is blocked until then).
   - **Configurations**: open a file, edit it and **Enregistrer**, add a new file or upload one (images, resource packs...).
5. Type the version and click **Publier pour les joueurs**: every launcher gets it at the next **JOUER** (mods are downloaded straight from CurseForge, only what changed).

Importing a new export replaces the list of mods and configurations (changes not published yet are lost).

**Other method:** your **CurseForge instance** of the modpack (the folder with `mods/`, `config/`, `kubejs/`..., found with CurseForge > your profile > **...** > **Open Folder**). There are two ways to publish it this way:

- **The instance is on the server's PC** (simplest): in `start-agent.bat`, set `MODPACK_DIR` to that folder and `GITHUB_TOKEN` (Contents: Read and write on this repository), then restart the agent. Its window shows `Modpack: <folder>`, and you publish from the admin website.
- **The instance is on another PC:** install Node.js 22 there, copy `paper-agent/` to it, copy `publish-modpack.example.bat` to `publish-modpack.bat`, fill in `MODPACK_DIR` and `GITHUB_TOKEN`, and double-click it. It asks for the version (Minecraft and NeoForge are read from the instance). Then on the admin website: **Modpack** tab > **Activer** on that version.

**Each time you change the modpack:**
1. Change the mods and configs in the instance and test it in CurseForge first (`branding/GUIDE.md` explains how to customise it).
2. Admin website → **Modpack** tab → type the new version (e.g. `1.0.1`), check **Minecraft** (`1.21.1`) and **NeoForge** (the version of your instance, e.g. `21.1.211`) → **Publier depuis le PC du serveur** (or run `publish-modpack.bat` on the other PC, then **Activer**).
3. Only **the changed files** are sent to the `modpack` release on GitHub (a pre-release, separate from the launcher's versions). The first time, the whole modpack is uploaded, which can take a while.
4. When it says *Modpack x publié*, every launcher gets it at the next click on **JOUER**. Players only download what changed.

What is sent: everything in the instance except the player's own data and caches (`saves`, `logs`, `screenshots`, `simplebackups`, `schematics`, `journeymap`, `servers.dat`, `dynamic-*-pack-cache`, `moonlight-global-datapacks`, CurseForge's own files...). Mods and files over 1 MB are sent one by one; small files (configs, scripts) go in one zip. `options.txt` and a few personal settings are only installed the first time, never overwritten.

**What players see:** the first time, **INSTALLER** downloads Java, NeoForge, Minecraft and the modpack with the steps, progress, speed and time remaining (5 to 20 minutes). After that the button is **JOUER**: it applies updates, starts NeoForge and joins the server. Each season gets its own game folder (`.atm/instances/saison-3`), set by the **Saison** field in the **Serveur** tab.

> The modpack files are public on GitHub (the repository is public). Many mods allow redistribution in a modpack, but some don't: check the licenses of the mods you add.

### 4. Publish the launcher (and its updates)

The installer is built by GitHub (on a Windows machine) with `.github/workflows/release.yml`.

**Once:** in the GitHub repository, **Settings** → **Secrets and variables** → **Actions** → **Variables** tab → add:
- `SERVER_URL` = your Render URL, e.g. `https://atm-admin.onrender.com/`
- `AZURE_CLIENT_ID` = the ID from step 1 (only a fallback: the ID approved by Microsoft is written in `launcher.config.json` and wins)

**Every time you want to release a version**, push to `main` with a commit message that contains:

```
[off_update] [1.2.0] Short description of what changed
```

```bash
git commit -m "[off_update] [1.2.0] Nouveau bouton Paramètres"
git push origin main
```

(On github.com, type the same thing in the **Commit message** box when you edit a file or merge a pull request.)

**Version names:** versions are called `v1.0.0 - Sweet Minecraft Treat` (the launcher's title bar shows `v1.0.0 - SMT`). The name stays the same from one version to the next until you change it, by adding `[name: New Name]` to the release commit:

```
[off_update] [2.0.0] [name: Nether Party] Saison 4
```

In the admin website's **Fusionner** dialog, fill in **Nom de la version** (empty = keep the current name). The first name comes from `releaseName` in `package.json`.

What happens next, automatically:
1. GitHub builds `ATM-Setup.exe` with version **1.2.0** (about 5 minutes; follow it in the **Actions** tab), plus the list of the launcher's files with their fingerprint (`app-update.json`).
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
ATM_SERVER_URL=http://localhost:8080/ npm start            # launcher pointed at it
```

Game files are stored in `%APPDATA%\.atm` (Windows), `~/Library/Application Support/.atm` (macOS) or `~/.config/.atm` (Linux). The game output is written to `logs/launcher-latest.log` there.

```
src/main/            launcher: window, Microsoft login, file sync, Minecraft install/launch, server status, self-update
src/renderer/        launcher UI
admin-panel/         admin website (no dependencies)
paper-agent/         agent for the Paper machine (no dependencies)
tools/               manifest builder + release helpers
build/icon.png       app icon
render.yaml          Render Blueprint
.github/workflows/   builds ATM-Setup.exe
```
