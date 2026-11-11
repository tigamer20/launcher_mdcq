// Writes a ZIP file straight to disk, one file at a time, so the website never holds the whole archive in memory
// (Render's free plan has 512 MB). Same format as paper-agent/zip.js, read by the launcher's src/main/unzip.js.
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** const zip = new ZipWriter(file); zip.add(name, data)...; const { sha1, size, files } = zip.close(); */
class ZipWriter {
  constructor(file) {
    this.fd = fs.openSync(file, 'w');
    this.hash = crypto.createHash('sha1');
    this.offset = 0;
    this.central = [];
    this.names = [];
  }

  write(buf) {
    fs.writeSync(this.fd, buf);
    this.hash.update(buf);
    this.offset += buf.length;
  }

  add(name, data) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(this.offset, 42);
    this.central.push(entry, nameBuf);
    this.names.push(name);

    this.write(local);
    this.write(nameBuf);
    this.write(compressed);
  }

  close() {
    const centralBuf = Buffer.concat(this.central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.names.length, 8);
    end.writeUInt16LE(this.names.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(this.offset, 16);
    this.write(centralBuf);
    this.write(end);
    fs.closeSync(this.fd);
    return { sha1: this.hash.digest('hex'), size: this.offset, files: this.names };
  }
}

module.exports = { ZipWriter };
