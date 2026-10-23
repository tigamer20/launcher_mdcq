// Everything needed to install and start Minecraft: versions, libraries, assets, Java and launch.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { downloadAll, fetchJson } = require('./download');
const { extractZip } = require('./unzip');

const VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const JAVA_MANIFEST =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const ASSETS_URL = 'https://resources.download.minecraft.net/';
const LIBRARIES_URL = 'https://libraries.minecraft.net/';

const OS_NAME = { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform];
const CP_SEPARATOR = process.platform === 'win32' ? ';' : ':';

// ---------------------------------------------------------------------------
// Version JSON (vanilla + mod loaders like Forge / NeoForge / Fabric)
// ---------------------------------------------------------------------------

async function readVersionJson(root, id) {
  const file = path.join(root, 'versions', id, `${id}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));

  // Not shipped by the server: it must be a vanilla version from Mojang.
  const manifest = await fetchJson(VERSION_MANIFEST);
  const entry = manifest.versions.find((v) => v.id === id);
  if (!entry) throw new Error(`Version Minecraft introuvable: ${id}`);
  await downloadAll([{ url: entry.url, dest: file, sha1: entry.sha1 }]);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Loads a version and merges it with its parent ("inheritsFrom"), like the official launcher.
async function loadVersion(root, id) {
  const version = await readVersionJson(root, id);
  if (!version.inheritsFrom) return version;

  const parent = await loadVersion(root, version.inheritsFrom);
  return {
    ...parent,
    ...version,
    jar: version.jar || parent.jar || parent.id,
    libraries: [...(version.libraries || []), ...(parent.libraries || [])],
    arguments: version.arguments || parent.arguments
      ? {
          game: [...(parent.arguments?.game || []), ...(version.arguments?.game || [])],
          jvm: [...(parent.arguments?.jvm || []), ...(version.arguments?.jvm || [])],
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Rules & libraries
// ---------------------------------------------------------------------------

function rulesAllow(rules, features = {}) {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    let match = true;
    if (rule.os) {
      if (rule.os.name && rule.os.name !== OS_NAME) match = false;
      if (rule.os.arch === 'x86' && process.arch !== 'ia32') match = false;
      if (rule.os.version && !new RegExp(rule.os.version).test(os.release())) match = false;
    }
    if (rule.features) {
      for (const [key, value] of Object.entries(rule.features)) {
        if (Boolean(features[key]) !== value) match = false;
      }
    }
    if (match) allowed = rule.action === 'allow';
  }
  return allowed;
}

// "group:artifact:version[:classifier][@ext]" -> "group/path/artifact/version/artifact-version[-classifier].ext"
function mavenPath(name) {
  const [coords, ext = 'jar'] = name.split('@');
  const [group, artifact, version, classifier] = coords.split(':');
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`;
  return [...group.split('.'), artifact, version, file].join('/');
}

// Returns the jar files a library needs: { path, url, sha1, size, native, exclude }.
function libraryFiles(lib) {
  const files = [];
  const artifact = lib.downloads?.artifact;
  if (artifact) {
    files.push({ path: artifact.path || mavenPath(lib.name), url: artifact.url, sha1: artifact.sha1, size: artifact.size });
  } else if (!lib.downloads && !lib.natives) {
    const p = mavenPath(lib.name);
    const base = (lib.url || LIBRARIES_URL).replace(/\/?$/, '/');
    files.push({ path: p, url: base + p, sha1: lib.sha1, size: lib.size });
  }

  // Old-style natives (Minecraft 1.18 and older): a classifier jar that must be extracted.
  const nativeKey = lib.natives?.[OS_NAME]?.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
  if (nativeKey) {
    const classifier = lib.downloads?.classifiers?.[nativeKey];
    const p = classifier?.path || mavenPath(`${lib.name}:${nativeKey}`);
    files.push({
      path: p,
      url: classifier ? classifier.url : (lib.url || LIBRARIES_URL).replace(/\/?$/, '/') + p,
      sha1: classifier?.sha1,
      size: classifier?.size,
      native: true,
      exclude: lib.extract?.exclude || [],
    });
  }
  return files;
}

// Libraries that apply to this computer, without duplicates (the mod loader's copy wins).
function resolveLibraries(version) {
  const seen = new Set();
  const result = [];
  for (const lib of version.libraries) {
    if (!rulesAllow(lib.rules)) continue;
    const [group, artifact, , classifier = ''] = lib.name.split('@')[0].split(':');
    const key = `${group}:${artifact}:${classifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(...libraryFiles(lib));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Java runtime (downloaded from Mojang, same as the official launcher)
// ---------------------------------------------------------------------------

function javaPlatform() {
  const map = {
    'win32-x64': 'windows-x64',
    'win32-ia32': 'windows-x86',
    'win32-arm64': 'windows-arm64',
    'darwin-x64': 'mac-os',
    'darwin-arm64': 'mac-os-arm64',
    'linux-x64': 'linux',
    'linux-ia32': 'linux-i386',
  };
  return map[`${process.platform}-${process.arch}`];
}

async function installJava(root, component, onProgress) {
  const all = await fetchJson(JAVA_MANIFEST);
  const entry = all[javaPlatform()]?.[component]?.[0];
  if (!entry) return 'java'; // no official build for this system: use the Java installed on the PC

  const dir = path.join(root, 'runtime', component);
  const { files } = await fetchJson(entry.manifest.url);
  const tasks = [];
  const links = [];
  for (const [name, info] of Object.entries(files)) {
    const dest = path.join(dir, name);
    if (info.type === 'file') {
      const raw = info.downloads.raw;
      tasks.push({ url: raw.url, dest, sha1: raw.sha1, size: raw.size, executable: info.executable });
    } else if (info.type === 'link') {
      links.push({ dest, target: info.target });
    }
  }
  await downloadAll(tasks, onProgress);
  for (const link of links) {
    if (fs.existsSync(link.dest)) continue;
    fs.mkdirSync(path.dirname(link.dest), { recursive: true });
    fs.symlinkSync(link.target, link.dest);
  }

  if (process.platform === 'win32') return path.join(dir, 'bin', 'javaw.exe');
  const macJava = path.join(dir, 'jre.bundle', 'Contents', 'Home', 'bin', 'java');
  return fs.existsSync(macJava) ? macJava : path.join(dir, 'bin', 'java');
}

// ---------------------------------------------------------------------------
// Install: client jar, libraries, assets, logging config, Java
// ---------------------------------------------------------------------------

/**
 * Downloads everything Minecraft needs for `versionId`.
 * onStatus(text, progress) is called with a 0..1 progress (or null when unknown).
 */
async function install(root, versionId, onStatus) {
  onStatus('Lecture de la version...', null);
  const version = await loadVersion(root, versionId);
  const progress = (text) => ({ done, total }) => onStatus(text, total ? done / total : null);

  // Client jar: downloaded once for the vanilla version, copied for the mod loader version.
  const jarId = version.jar || version.id;
  const vanillaJar = path.join(root, 'versions', jarId, `${jarId}.jar`);
  const client = version.downloads?.client;
  if (client) {
    onStatus('Téléchargement du jeu...', null);
    await downloadAll([{ url: client.url, dest: vanillaJar, sha1: client.sha1, size: client.size }], progress('Téléchargement du jeu...'));
  }
  const clientJar = path.join(root, 'versions', version.id, `${version.id}.jar`);
  if (clientJar !== vanillaJar) {
    fs.mkdirSync(path.dirname(clientJar), { recursive: true });
    fs.copyFileSync(vanillaJar, clientJar);
  }

  // Libraries
  onStatus('Téléchargement des librairies...', null);
  const libraries = resolveLibraries(version);
  const libDir = path.join(root, 'libraries');
  const missing = libraries.filter((l) => !l.url && !fs.existsSync(path.join(libDir, l.path)));
  if (missing.length) {
    throw new Error(`Librairie manquante sur le serveur de fichiers: libraries/${missing[0].path}`);
  }
  await downloadAll(
    libraries.filter((l) => l.url).map((l) => ({ url: l.url, dest: path.join(libDir, l.path), sha1: l.sha1, size: l.size })),
    progress('Téléchargement des librairies...'),
  );

  // Assets (sounds, textures, languages...)
  onStatus('Téléchargement des ressources...', null);
  const assetsDir = path.join(root, 'assets');
  const indexInfo = version.assetIndex;
  const indexFile = path.join(assetsDir, 'indexes', `${indexInfo.id}.json`);
  await downloadAll([{ url: indexInfo.url, dest: indexFile, sha1: indexInfo.sha1, size: indexInfo.size }]);
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const objects = Object.entries(index.objects).map(([name, { hash, size }]) => ({
    name,
    url: `${ASSETS_URL}${hash.slice(0, 2)}/${hash}`,
    dest: path.join(assetsDir, 'objects', hash.slice(0, 2), hash),
    sha1: hash,
    size,
  }));
  await downloadAll(objects, progress('Téléchargement des ressources...'));

  // Very old versions (before 1.7.10) read assets by name instead of by hash.
  let legacyAssets = null;
  if (index.virtual || index.map_to_resources) {
    legacyAssets = index.map_to_resources ? path.join(root, 'resources') : path.join(assetsDir, 'virtual', indexInfo.id);
    for (const obj of objects) {
      const target = path.join(legacyAssets, obj.name);
      if (fs.existsSync(target)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(obj.dest, target);
    }
  }

  // Log4j configuration (also protects older versions against "Log4Shell")
  let loggingArg = null;
  const logging = version.logging?.client;
  if (logging?.file) {
    const dest = path.join(assetsDir, 'log_configs', logging.file.id);
    await downloadAll([{ url: logging.file.url, dest, sha1: logging.file.sha1, size: logging.file.size }]);
    loggingArg = logging.argument.replace('${path}', dest);
  }

  // Java
  onStatus('Installation de Java...', null);
  const javaComponent = version.javaVersion?.component || 'jre-legacy';
  const java = await installJava(root, javaComponent, progress('Installation de Java...'));

  // Natives (only used by Minecraft 1.18 and older)
  const nativesDir = path.join(root, 'versions', version.id, 'natives');
  fs.rmSync(nativesDir, { recursive: true, force: true });
  fs.mkdirSync(nativesDir, { recursive: true });
  for (const lib of libraries.filter((l) => l.native)) {
    extractZip(path.join(libDir, lib.path), nativesDir, ['META-INF/', ...lib.exclude]);
  }

  return { version, java, libraries, clientJar, nativesDir, loggingArg, legacyAssets };
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

function flattenArgs(list, features) {
  const out = [];
  for (const arg of list || []) {
    if (typeof arg === 'string') out.push(arg);
    else if (rulesAllow(arg.rules, features)) out.push(...[].concat(arg.value));
  }
  return out;
}

/**
 * Starts Minecraft. Returns the child process.
 * options = { account: { name, uuid, accessToken }, ramMb, server: { host, port } }
 */
function launch(root, installed, options) {
  const { version, java, libraries, clientJar, nativesDir, loggingArg, legacyAssets } = installed;
  const { account, ramMb, server } = options;

  const classpath = [
    ...libraries.filter((l) => !l.native).map((l) => path.join(root, 'libraries', l.path)),
    clientJar,
  ].join(CP_SEPARATOR);

  const serverAddress = server ? `${server.host}:${server.port || 25565}` : '';
  const vars = {
    auth_player_name: account.name,
    auth_uuid: account.uuid,
    auth_access_token: account.accessToken,
    auth_session: `token:${account.accessToken}:${account.uuid}`,
    auth_xuid: '',
    clientid: '',
    user_type: 'msa',
    user_properties: '{}',
    version_name: version.id,
    version_type: version.type || 'release',
    game_directory: root,
    assets_root: path.join(root, 'assets'),
    game_assets: legacyAssets || path.join(root, 'assets'),
    assets_index_name: version.assetIndex.id,
    natives_directory: nativesDir,
    library_directory: path.join(root, 'libraries'),
    classpath,
    classpath_separator: CP_SEPARATOR,
    launcher_name: 'ModdedQC',
    launcher_version: '1.0.0',
    quickPlayMultiplayer: serverAddress,
    quick_play_multiplayer: serverAddress,
  };
  const fill = (s) => s.replace(/\$\{(\w+)\}/g, (match, key) => (key in vars ? vars[key] : match));
  const features = { is_quick_play_multiplayer: Boolean(server) };

  let jvmArgs;
  let gameArgs;
  if (version.arguments) {
    jvmArgs = flattenArgs(version.arguments.jvm, features);
    gameArgs = flattenArgs(version.arguments.game, features);
  } else {
    jvmArgs = ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'];
    if (process.platform === 'darwin') jvmArgs.unshift('-XstartOnFirstThread');
    gameArgs = version.minecraftArguments.split(' ');
  }
  // Versions without "Quick Play" (before 1.20) use --server / --port to join automatically.
  if (server && !gameArgs.includes('--quickPlayMultiplayer')) {
    gameArgs.push('--server', server.host, '--port', String(server.port || 25565));
  }

  const args = [
    `-Xmx${ramMb}M`,
    `-Xms${Math.min(ramMb, 1024)}M`,
    ...jvmArgs.map(fill),
    ...(loggingArg ? [loggingArg] : []),
    version.mainClass,
    ...gameArgs.map(fill),
  ];

  const logDir = path.join(root, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.createWriteStream(path.join(logDir, 'launcher-latest.log'));
  const child = spawn(java, args, { cwd: root });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return child;
}

module.exports = { install, launch, mavenPath, resolveLibraries, loadVersion, rulesAllow };
