// Photos of the launcher's background carousel ("Photos" tab of the admin website).
//
// Admins add photos by drag and drop and choose which ones are shown. Players can send a photo from the launcher:
// it waits in "Demandes des joueurs" until an admin approves or refuses it.
// Files: data/gallery/<id>.<ext> (the photos) and data/gallery-pending/<id>.<ext> (the requests), the list in
// data/gallery.json. Everything is also kept on GitHub (admin-data branch) like the rest of the data.
// The launchers get the visible photos from the public manifest (pack.gallery) and download them from /gallery/.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_SIZE = 10 * 1024 * 1024; // per photo
const MAX_PENDING_PER_PLAYER = 3;
const FILE = 'gallery.json';

let dataDir = null;
let persist = null; // { save(relative, buffer), remove(relative) } or null
let data = { photos: [], requests: [] };

const fail = (status, message) => Object.assign(new Error(message), { status });

/** The real type of an image from its first bytes (never trust the name or the browser). */
function imageType(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return null;
}

const MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function init(options) {
  ({ dataDir } = options);
  persist = options.persist || null;
  fs.mkdirSync(path.join(dataDir, 'gallery'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'gallery-pending'), { recursive: true });
  try {
    data = { photos: [], requests: [], ...JSON.parse(fs.readFileSync(path.join(dataDir, FILE), 'utf8')) };
  } catch {
    data = { photos: [], requests: [] };
  }
}

async function saveList() {
  const buffer = Buffer.from(JSON.stringify(data, null, 1));
  fs.writeFileSync(path.join(dataDir, FILE), buffer);
  if (persist) await persist.save(FILE, buffer);
}

async function writeImage(folder, file, buffer) {
  fs.writeFileSync(path.join(dataDir, folder, file), buffer);
  if (persist) await persist.save(`${folder}/${file}`, buffer);
}

async function removeImage(folder, file) {
  fs.rmSync(path.join(dataDir, folder, file), { force: true });
  if (persist) await persist.remove(`${folder}/${file}`).catch(() => {});
}

function checkImage(buffer) {
  if (!buffer.length) throw fail(400, 'Fichier vide');
  if (buffer.length > MAX_SIZE) throw fail(413, 'Photo trop grosse (10 Mo maximum)');
  const ext = imageType(buffer);
  if (!ext) throw fail(400, 'Ce fichier n\'est pas une photo JPG, PNG ou WEBP');
  return ext;
}

const cleanName = (name) => String(name || '').replace(/[\r\n]/g, ' ').trim().slice(0, 80) || 'Photo';
const newId = () => crypto.randomBytes(8).toString('hex');

/** The visible photos, for the public manifest: [{ id, file }] in display order. */
function publicList() {
  return data.photos.filter((p) => p.visible).map(({ id, file }) => ({ id, file }));
}

/** For the admin website. */
function list() {
  return { photos: data.photos, requests: data.requests };
}

async function addPhoto(buffer, { name, by }) {
  const ext = checkImage(buffer);
  const id = newId();
  const photo = { id, file: `${id}${ext}`, name: cleanName(name), visible: true, addedBy: by, addedAt: new Date().toISOString() };
  await writeImage('gallery', photo.file, buffer);
  data.photos.push(photo);
  await saveList();
  return list();
}

function findPhoto(id) {
  const photo = data.photos.find((p) => p.id === id);
  if (!photo) throw fail(404, 'Photo introuvable');
  return photo;
}

async function setVisible(id, visible) {
  findPhoto(id).visible = Boolean(visible);
  await saveList();
  return list();
}

// direction: -1 (earlier in the carousel) or 1 (later)
async function move(id, direction) {
  const i = data.photos.indexOf(findPhoto(id));
  const j = i + (direction < 0 ? -1 : 1);
  if (j < 0 || j >= data.photos.length) return list();
  [data.photos[i], data.photos[j]] = [data.photos[j], data.photos[i]];
  await saveList();
  return list();
}

async function removePhoto(id) {
  const photo = findPhoto(id);
  data.photos = data.photos.filter((p) => p !== photo);
  await removeImage('gallery', photo.file);
  await saveList();
  return list();
}

/** A player sends a photo from the launcher (already checked with Mojang by the caller). */
async function addRequest(buffer, { name, player, uuid }) {
  const ext = checkImage(buffer);
  if (data.requests.filter((r) => r.uuid === uuid).length >= MAX_PENDING_PER_PLAYER) {
    throw fail(429, `Tu as déjà ${MAX_PENDING_PER_PLAYER} photos en attente : attends qu'un admin les regarde`);
  }
  const id = newId();
  const request = { id, file: `${id}${ext}`, name: cleanName(name), player, uuid, sentAt: new Date().toISOString() };
  await writeImage('gallery-pending', request.file, buffer);
  data.requests.push(request);
  await saveList();
}

function findRequest(id) {
  const request = data.requests.find((r) => r.id === id);
  if (!request) throw fail(404, 'Demande introuvable');
  return request;
}

/** Approved: the photo joins the carousel (visible), credited to the player. */
async function approve(id, by) {
  const request = findRequest(id);
  const buffer = fs.readFileSync(path.join(dataDir, 'gallery-pending', request.file));
  await writeImage('gallery', request.file, buffer);
  await removeImage('gallery-pending', request.file);
  data.requests = data.requests.filter((r) => r !== request);
  data.photos.push({
    id: request.id,
    file: request.file,
    name: request.name,
    visible: true,
    addedBy: by,
    addedAt: new Date().toISOString(),
    player: request.player,
  });
  await saveList();
  return list();
}

async function deny(id) {
  const request = findRequest(id);
  data.requests = data.requests.filter((r) => r !== request);
  await removeImage('gallery-pending', request.file);
  await saveList();
  return list();
}

/** The file of a photo (public: only visible ones) or of a request (admins only). */
function imageFile({ id, file, pending = false, onlyVisible = false }) {
  const item = pending
    ? data.requests.find((r) => r.id === id || r.file === file)
    : data.photos.find((p) => (p.id === id || p.file === file) && (!onlyVisible || p.visible));
  if (!item) throw fail(404, 'Photo introuvable');
  return { path: path.join(dataDir, pending ? 'gallery-pending' : 'gallery', item.file), type: MIME[path.extname(item.file)] };
}

module.exports = { init, list, publicList, addPhoto, setVisible, move, removePhoto, addRequest, approve, deny, imageFile, MAX_SIZE };
