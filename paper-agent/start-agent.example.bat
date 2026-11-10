@echo off
chcp 65001 >nul
rem ATM agent for Windows (All the Mod server).
rem 1. Install Node.js 22 LTS (https://nodejs.org).
rem 2. Copy this file to start-agent.bat (same folder) and fill in the values below.
rem 3. Double-click start-agent.bat. Leave the window open while the Minecraft server runs.
rem    Allow Node.js when Windows Defender Firewall asks, and set sleep to "Never" in Settings > System > Power.
rem Never share or commit start-agent.bat: it contains your secrets.

set AGENT_SECRET=paste-the-same-secret-as-on-Render
rem The SERVER folder (All the Mods 10 server pack: the one with server.properties)
set PAPER_DIR=C:\Minecraft\all-the-mod-server
set RCON_PASSWORD=same-as-rcon.password-in-server.properties

rem Modpack publishing from the admin website (Modpack tab). Optional.
rem MODPACK_DIR: the CurseForge instance of the modpack (CurseForge > your profile > ... > Open Folder)
set MODPACK_DIR=C:\Users\YOUR_NAME\curseforge\minecraft\Instances\All the Mods 10 - Saison 3
rem Same kind of GitHub token as on Render (Contents: Read and write on tigamer20/launcher_mdcq)
set GITHUB_TOKEN=github_pat_...

node "%~dp0agent.js"
pause
