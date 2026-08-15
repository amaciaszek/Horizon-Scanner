'use strict';

// Small, dependency-free ZIP32 writer. Entries are stored without compression:
// JPEGs are already compressed, and avoiding a compression dependency keeps the
// field export available offline on every browser the scanner supports.

let crcTable = null;

function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function cleanName(name) {
  const clean = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.split('/').some(part => part === '..')) throw new Error(`Unsafe ZIP entry name: ${name}`);
  return clean;
}

function dosDateTime(value) {
  const d = value instanceof Date ? value : new Date(value || Date.now());
  const year = Math.max(1980, d.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  };
}

async function toBytes(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  throw new TypeError('ZIP entries must contain text, a Blob, an ArrayBuffer, or a typed array.');
}

async function inspectEntryData(data) {
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    // Read once for the CRC, but keep the original Blob as the ZIP payload so
    // all source photos are not duplicated in memory at the same time.
    return { bytes: new Uint8Array(await data.arrayBuffer()), payload: data, size: data.size };
  }
  const bytes = await toBytes(data);
  return { bytes, payload: bytes, size: bytes.byteLength };
}

/** Build a standards-compliant ZIP Blob from [{ name, data, modifiedAt? }]. */
export async function buildZip(entries) {
  if (!Array.isArray(entries)) throw new TypeError('ZIP entries must be an array.');
  if (entries.length > 0xffff) throw new Error('ZIP contains too many files for ZIP32.');

  const pieces = [];
  const central = [];
  const seen = new Set();
  let offset = 0;

  for (const entry of entries) {
    const name = cleanName(entry.name);
    if (seen.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
    seen.add(name);

    const nameBytes = new TextEncoder().encode(name);
    const source = await inspectEntryData(entry.data);
    const checksum = crc32(source.bytes);
    const stamp = dosDateTime(entry.modifiedAt);
    if (source.size > 0xffffffff || offset > 0xffffffff) throw new Error('ZIP is too large for ZIP32.');

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);             // version needed
    lv.setUint16(6, 0x0800, true);         // UTF-8 names
    lv.setUint16(8, 0, true);              // stored (no compression)
    lv.setUint16(10, stamp.time, true);
    lv.setUint16(12, stamp.date, true);
    lv.setUint32(14, checksum, true);
    lv.setUint32(18, source.size, true);
    lv.setUint32(22, source.size, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    pieces.push(local, source.payload);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);              // version made by
    cv.setUint16(6, 20, true);              // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, stamp.time, true);
    cv.setUint16(14, stamp.date, true);
    cv.setUint32(16, checksum, true);
    cv.setUint32(20, source.size, true);
    cv.setUint32(24, source.size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.byteLength + source.size;
  }

  const centralOffset = offset;
  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  if (centralOffset + centralSize > 0xffffffff) throw new Error('ZIP is too large for ZIP32.');
  pieces.push(...central);

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  pieces.push(end);

  return new Blob(pieces, { type: 'application/zip' });
}
