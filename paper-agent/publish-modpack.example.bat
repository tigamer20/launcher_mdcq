@echo off
chcp 65001 >nul
rem Publishes the modpack from THIS PC (where the CurseForge instance is) to GitHub.
rem 1. Install Node.js 22 LTS (https://nodejs.org) if it isn't already.
rem 2. Copy this file to publish-modpack.bat (same folder) and fill in the 2 values below.
rem 3. Double-click publish-modpack.bat each time you want to publish a new version of the modpack,
rem    then on the admin website: Modpack tab > "Activer" on the new version.
rem Never share or commit publish-modpack.bat: it contains your GitHub token.

rem Path of the instance: CurseForge > your profile > ... > Open Folder, then copy the address bar.
set MODPACK_DIR=C:\Users\YOUR_NAME\curseforge\minecraft\Instances\All the Mods 10 - Saison 3
set GITHUB_TOKEN=github_pat_...

node "%~dp0publish-modpack.js"
pause
