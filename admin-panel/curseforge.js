// CurseForge API (https://docs.curseforge.com/rest-api/): finds mods and their download links.
// Needs CURSEFORGE_API_KEY on Render (free key: https://console.curseforge.com, "API Keys").
const API = process.env.CURSEFORGE_API || 'https://api.curseforge.com';
const KEY = process.env.CURSEFORGE_API_KEY;
const MINECRAFT = 432;
const NEOFORGE = 6; // modLoaderType
const SHA1 = 1; // hash algorithm id

// Where each kind of CurseForge project goes in the game folder (classId -> folder).
const FOLDERS = { 6: 'mods', 12: 'resourcepacks', 6552: 'shaderpacks' };

const configured = () => Boolean(KEY);

async function cf(method, path, body) {
  if (!KEY) throw new Error('CURSEFORGE_API_KEY manquant sur Render (clé gratuite sur console.curseforge.com)');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'x-api-key': KEY, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 403) throw new Error('Clé CurseForge refusée (vérifie CURSEFORGE_API_KEY sur Render)');
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`CurseForge : erreur ${res.status}`);
  return (await res.json()).data;
}

// CurseForge sometimes gives links with spaces or "+" in the file name: encode it so every download works.
function cleanUrl(url) {
  if (!url) return null;
  const i = url.lastIndexOf('/');
  return url.slice(0, i + 1) + encodeURIComponent(decodeURIComponent(url.slice(i + 1)));
}

// A CurseForge file in the form the editor keeps.
function describeFile(file) {
  return {
    fileId: file.id,
    fileName: file.fileName,
    displayName: file.displayName,
    date: file.fileDate,
    releaseType: file.releaseType, // 1 release, 2 beta, 3 alpha
    gameVersions: file.gameVersions || [],
    size: file.fileLength,
    sha1: (file.hashes || []).find((h) => h.algo === SHA1)?.value || null,
    url: cleanUrl(file.downloadUrl), // null: the author doesn't allow other apps to download it
  };
}

function describeMod(mod) {
  return {
    projectId: mod.id,
    name: mod.name,
    slug: mod.slug,
    link: mod.links?.websiteUrl || null,
    folder: FOLDERS[mod.classId] || 'mods',
    icon: mod.logo?.thumbnailUrl || null,
  };
}

async function inBatches(ids, size, fn) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(...((await fn(ids.slice(i, i + size))) || []));
  return out;
}

/** Files by id -> Map(fileId -> file). */
async function getFiles(fileIds) {
  const files = await inBatches(fileIds, 500, (fileIds) => cf('POST', '/v1/mods/files', { fileIds }));
  return new Map(files.map((f) => [f.id, describeFile(f)]));
}

/** Mods by id -> Map(projectId -> mod). */
async function getMods(modIds) {
  const mods = await inBatches(modIds, 500, (modIds) => cf('POST', '/v1/mods', { modIds, filterPcOnly: true }));
  return new Map(mods.map((m) => [m.id, describeMod(m)]));
}

/** Versions of a mod that work with this Minecraft version and NeoForge (newest first). */
async function listVersions(projectId, minecraft) {
  const query = new URLSearchParams({ gameVersion: minecraft, modLoaderType: NEOFORGE, pageSize: 50 });
  let files = (await cf('GET', `/v1/mods/${projectId}/files?${query}`)) || [];
  // Resource packs and shaders have no mod loader: ask again without it.
  if (!files.length) files = (await cf('GET', `/v1/mods/${projectId}/files?gameVersion=${encodeURIComponent(minecraft)}&pageSize=50`)) || [];
  return files.map(describeFile).sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Finds a project from what the admin pasted: a CurseForge link (with or without /files/<id>), a slug or an id.
 * Returns { mod, fileId|null }.
 */
async function findProject(input) {
  const text = String(input || '').trim();
  let fileId = null;
  let mod = null;
  const link = /curseforge\.com\/minecraft\/([a-z-]+)\/([a-z0-9-_]+)(?:\/(?:files|download)\/(\d+))?/i.exec(text);
  if (/^\d+$/.test(text)) {
    mod = await cf('GET', `/v1/mods/${text}`);
  } else {
    const slug = link ? link[2] : text.toLowerCase();
    if (link?.[3]) fileId = Number(link[3]);
    const found = (await cf('GET', `/v1/mods/search?gameId=${MINECRAFT}&slug=${encodeURIComponent(slug)}`)) || [];
    mod = found.find((m) => m.slug === slug) || found[0] || null;
  }
  if (!mod) throw new Error('Projet introuvable sur CurseForge (colle le lien de la page du mod)');
  return { mod: describeMod(mod), fileId };
}

module.exports = { configured, getFiles, getMods, listVersions, findProject, describeFile, FOLDERS };
