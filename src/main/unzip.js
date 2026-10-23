// Minimal ZIP extractor (stored + deflate), used for Minecraft native libraries.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function extractZip(zipFile, destDir, exclude = []) {
  const buf = fs.readFileSync(zipFile);

  // Find the "end of central directory" record by scanning backwards.
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error(`Archive ZIP invalide: ${zipFile}`);

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const root = path.resolve(destDir);

  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeader = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/') || exclude.some((prefix) => name.startsWith(prefix))) continue;

    const target = path.resolve(root, name);
    if (!target.startsWith(root + path.sep)) continue; // ignore path traversal entries

    const dataStart =
      localHeader + 30 + buf.readUInt16LE(localHeader + 26) + buf.readUInt16LE(localHeader + 28);
    const data = buf.subarray(dataStart, dataStart + compressedSize);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (method === 0) fs.writeFileSync(target, data);
    else if (method === 8) fs.writeFileSync(target, zlib.inflateRawSync(data));
    else throw new Error(`Compression ZIP non supportée (${method}) dans ${zipFile}`);
  }
}

module.exports = { extractZip };
