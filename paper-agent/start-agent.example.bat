@echo off
chcp 65001 >nul
rem ATM agent for Windows (All the Mod server).
rem 1. Install Node.js 22 LTS (https://nodejs.org).
rem 2. Copy this file to start-agent.bat (same folder) and fill in the values below.
rem 3. Double-click start-agent.bat. Leave the window open while the Minecraft server runs.
rem    Allow Node.js when Windows Defender Firewall asks, and set sleep to "Never" in Settings > System > Power.
rem Never share or commit start-agent.bat: it contains your secrets.

set AGENT_SECRET=paste-the-same-secret-as-on-Render
rem The SERVER folder (NeoForge server of All the Mods 10: the one with server.properties and mods\)
rem The agent detects NeoForge and manages its mods\ folder (or plugins\ on a Paper server).
set SERVER_DIR=C:\Minecraft\all-the-mod-server
set RCON_PASSWORD=same-as-rcon.password-in-server.properties

rem Modpack publishing from the admin website (Modpack tab). Optional.
rem MODPACK_DIR: the CurseForge instance of the modpack (CurseForge > your profile > ... > Open Folder)
set MODPACK_DIR=C:\Users\YOUR_NAME\curseforge\minecraft\Instances\All the Mods 10 - Saison 3
rem Same kind of GitHub token as on Render (Contents: Read and write on tigamer20/launcher_mdcq)
set GITHUB_TOKEN=github_pat_...

rem Cloudflare tunnel without a domain (free, no router port to open). Optional.
rem Install cloudflared once: winget install --id Cloudflare.cloudflared
rem The agent starts it and sends its address (a new one at every start) to the website: AGENT_URL isn't needed on Render.
set CLOUDFLARE_TUNNEL=1
set WEBSITE_URL=https://your-site.onrender.com/

node "%~dp0agent.js"
pause
