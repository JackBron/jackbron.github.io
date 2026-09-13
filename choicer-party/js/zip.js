// Minimal zip reader on top of the browser's DecompressionStream, so a
// package can arrive as one .zip without pulling in a library. Reads the
// central directory, hands back lazy entries; only the files you ask for are
// inflated. ZIP64 (over 4 GB or 65k entries) is out of scope for a game pack.

const SIG_EOCD = 0x06054b50;
const SIG_CDIR = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export async function readZip(file) {
  const size = file.size;
  const tailLen = Math.min(size, 65536 + 22);
  const tail = new DataView(await file.slice(size - tailLen).arrayBuffer());

  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip archive');

  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported');

  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const utf8 = new TextDecoder('utf-8');
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== SIG_CDIR) throw new Error('Corrupt zip central directory');
    const method = cd.getUint16(p + 10, true);
    const csize = cd.getUint32(p + 20, true);
    const usize = cd.getUint32(p + 24, true);
    const nlen = cd.getUint16(p + 28, true);
    const elen = cd.getUint16(p + 30, true);
    const clen = cd.getUint16(p + 32, true);
    const localOffset = cd.getUint32(p + 42, true);
    const name = utf8.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nlen));
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    const meta = { method, csize, usize, localOffset };
    entries.push({ path: name, size: usize, blob: () => extract(file, meta) });
  }
  return entries;
}

async function extract(file, { method, csize, localOffset }) {
  const lh = new DataView(await file.slice(localOffset, localOffset + 30).arrayBuffer());
  if (lh.getUint32(0, true) !== SIG_LOCAL) throw new Error('Corrupt zip local header');
  const nlen = lh.getUint16(26, true);
  const elen = lh.getUint16(28, true);
  const start = localOffset + 30 + nlen + elen;
  const raw = file.slice(start, start + csize);
  if (method === 0) return raw;
  if (method === 8) {
    const inflated = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(inflated).blob();
  }
  throw new Error(`Unsupported zip compression method ${method}`);
}
