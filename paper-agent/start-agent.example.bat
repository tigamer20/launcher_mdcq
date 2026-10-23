@echo off
rem ModdedQC agent for Windows.
rem 1. Copy this file to start-agent.bat (same folder) and fill in the 3 values below.
rem 2. Double-click start-agent.bat. Leave the window open while the Minecraft server runs.
rem Never share or commit start-agent.bat: it contains your secrets.

set AGENT_SECRET=paste-the-same-secret-as-on-Render
set PAPER_DIR=C:\Minecraft\paper
set RCON_PASSWORD=same-as-rcon.password-in-server.properties

node "%~dp0agent.js"
pause
