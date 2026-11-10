#!/bin/bash
# ModdedQC agent for macOS.
# 1. Copy this file to start-agent.command (same folder) and fill in the values below.
# 2. Double-click start-agent.command in Finder. Leave the Terminal window open while the server runs.
#    (first time: right-click > Open, because macOS blocks scripts it doesn't know)
# Never share or commit start-agent.command: it contains your secrets.

export AGENT_SECRET="paste-the-same-secret-as-on-Render"
export PAPER_DIR="$HOME/Minecraft/paper"
export RCON_PASSWORD="same-as-rcon.password-in-server.properties"

# Modpack publishing (admin website > Modpack tab). Optional.
# MODPACK_DIR: the CLIENT instance of the modpack (the folder that contains mods/, config/, kubejs/...),
# e.g. the CurseForge instance: ~/Documents/curseforge/minecraft/Instances/All the Mods 10
export MODPACK_DIR="$HOME/Documents/curseforge/minecraft/Instances/All the Mods 10"
# Same kind of GitHub token as on Render (Contents: Read and write on tigamer20/launcher_mdcq)
export GITHUB_TOKEN="github_pat_..."

cd "$(dirname "$0")"
# caffeinate keeps the Mac awake while the agent runs (a sleeping Mac can't answer the website).
caffeinate -i node agent.js
