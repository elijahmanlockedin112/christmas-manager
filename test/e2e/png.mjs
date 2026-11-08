// Real PNG files for the tests, built from scratch (no deps). 'noise' is incompressible; 'art' is a
// cream page with a crayon face and a few strokes, so screenshots of the TV gallery look like something.
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function makePng(w, h, kind = 'noise', seed = 1) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8;
  let raw;
  if (kind === 'noise') {
    ihdr[9] = 0;
    raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), crypto.randomBytes(w)])));
  } else {
    ihdr[9] = 2;
    const rows = [];
    const cols = [[214, 49, 43], [31, 154, 82], [58, 123, 224], [212, 162, 31]];
    const ink = cols[seed % cols.length];
    for (let y = 0; y < h; y++) {
      const row = Buffer.alloc(1 + w * 3);
      for (let x = 0; x < w; x++) {
        let px = [251, 245, 233];
        const dx = (x - w / 2) / (w * 0.22), dy = (y - h * 0.46) / (h * 0.3), r = Math.hypot(dx, dy);
        if (Math.abs(r - 1) < 0.045) px = [20, 40, 29];
        const ex = Math.min(Math.hypot((x - w * 0.43) / (w * 0.03), (y - h * 0.4) / (h * 0.04)), Math.hypot((x - w * 0.57) / (w * 0.03), (y - h * 0.4) / (h * 0.04)));
        if (ex < 1) px = ink;
        if (Math.abs(Math.hypot((x - w / 2) / (w * 0.1), (y - h * 0.55) / (h * 0.07)) - 1) < 0.12 && y > h * 0.55) px = [214, 49, 43];
        if (y > h * 0.8 && Math.abs(y - h * (0.82 + 0.03 * Math.sin(x / (w * 0.05) + seed))) < h * 0.012) px = ink;
        row[1 + x * 3] = px[0]; row[2 + x * 3] = px[1]; row[3 + x * 3] = px[2];
      }
      rows.push(row);
    }
    raw = Buffer.concat(rows);
  }
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export const pngUrl = (w, h, kind, seed) => 'data:image/png;base64,' + makePng(w, h, kind, seed).toString('base64');
