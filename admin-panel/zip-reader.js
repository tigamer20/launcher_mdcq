// Reads a ZIP file entry by entry without loading the whole archive in memory
// (a CurseForge export can weigh hundreds of MB, Render's free plan has 512 MB of RAM).
const fs = require('fs');
const zlib = require('zlib');

function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, position + done);
    if (!n) throw new Error('Archive ZIP tronquée');
    done += n;
  }
  return buf;
}

// ZIP64 archives keep the real sizes/offsets in an extra field.
function zip64Values(extra, wanted) {
  for (let i = 0; i + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(i);
    const size = extra.readUInt16LE(i + 2);
    if (id === 0x0001) {
      let p = i + 4;
      const out = {};
      for (const key of wanted) {
        out[key] = Number(extra.readBigUInt64LE(p));
        p += 8;
      }
      return out;
    }
    i += 4 + size;
  }
  return {};
}

/** Opens a ZIP file. Returns { entries: [{ name, size }], read(entry) -> Buffer, close() }. */
function openZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const tailSize = Math.min(fileSize, 65_557);
    const tail = readAt(fd, fileSize - tailSize, tailSize);
    let eocd = tail.length - 22;
    while (eocd >= 0 && tail.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    if (eocd < 0) throw new Error("Ce fichier n'est pas une archive ZIP valide");

    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    // ZIP64 end of central directory (archives over 4 GB or 65535 files)
    if (cdOffset === 0xffffffff || count === 0xffff) {
      const locator = eocd - 20;
      if (locator >= 0 && tail.readUInt32LE(locator) === 0x07064b50) {
        const record = readAt(fd, Number(tail.readBigUInt64LE(locator + 8)), 56);
        count = Number(record.readBigUInt64LE(32));
        cdSize = Number(record.readBigUInt64LE(40));
        cdOffset = Number(record.readBigUInt64LE(48));
      }
    }

    const cd = readAt(fd, cdOffset, cdSize);
    const entries = [];
    for (let p = 0, i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('Archive ZIP invalide (répertoire central)');
      const method = cd.readUInt16LE(p + 10);
      let compressedSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      const wanted = [];
      if (size === 0xffffffff) wanted.push('size');
      if (compressedSize === 0xffffffff) wanted.push('compressedSize');
      if (offset === 0xffffffff) wanted.push('offset');
      if (wanted.length) ({ size = size, compressedSize = compressedSize, offset = offset } = zip64Values(extra, wanted));
      p += 46 + nameLen + extraLen + commentLen;
      if (!name.endsWith('/')) entries.push({ name, size, compressedSize, method, offset });
    }

    return {
      entries,
      read(entry) {
        const header = readAt(fd, entry.offset, 30);
        const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
        const data = readAt(fd, start, entry.compressedSize);
        if (entry.method === 0) return data;
        if (entry.method === 8) return zlib.inflateRawSync(data);
        throw new Error(`Compression ZIP non supportée (${entry.method}) pour ${entry.name}`);
      },
      close: () => fs.closeSync(fd),
    };
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

module.exports = { openZip };
