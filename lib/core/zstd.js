/**
 * Concatenated-frame zstd container reader.
 *
 * A DSH session file (<sessionsRoot>/<workspace>/<session-id>/session.v4.jsonl.zstd)
 * is a sequence of independently compressed zstd frames, roughly one per append.
 * node:zlib decompresses only the FIRST frame, so the frame structure is walked
 * by hand here (no dependency, no native module).
 */
import fs from "node:fs";
import { zstdDecompressSync } from "node:zlib";

const ZSTD_MAGIC = 0xfd2fb528;

/** Byte offset just past the frame starting at off, without decompressing it. */
export function parseFrameEnd(b, off) {
  if (off + 5 > b.length || b.readUInt32LE(off) !== ZSTD_MAGIC) {
    throw new Error("bad zstd magic at " + off);
  }
  const fhd = b[off + 4];
  const fcsFlag = fhd >> 6;
  const single = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  const dictFlag = fhd & 3;
  let p = off + 5;
  if (!single) p += 1;
  p += dictFlag === 0 ? 0 : dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : 4;
  p += fcsFlag === 0 ? (single ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
  for (;;) {
    if (p + 3 > b.length) throw new Error("truncated block header at " + p);
    const h = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
    p += 3;
    const last = h & 1;
    const type = (h >> 1) & 3;
    const size = h >>> 3;
    if (type === 3) throw new Error("reserved block type at " + (p - 3));
    if (type === 0 || type === 2) p += size; else p += 1; // 1 = RLE
    if (p > b.length) throw new Error("truncated block payload");
    if (last) break;
  }
  if (checksum) p += 4;
  if (p > b.length) throw new Error("truncated frame checksum");
  return p;
}

/** [start, end) slices of every frame in the container. */
export function frameSlices(b) {
  const out = [];
  let off = 0;
  while (off < b.length) {
    const end = parseFrameEnd(b, off);
    out.push([off, end]);
    off = end;
  }
  return out;
}

export function decodeFrame(b, slice) {
  return zstdDecompressSync(b.subarray(slice[0], slice[1]));
}

/** Decompress the last N frames; returns Buffers oldest first. */
export function tailFrames(b, count) {
  const slices = frameSlices(b);
  const picked = count > 0 ? slices.slice(-count) : slices;
  return picked.map((s) => decodeFrame(b, s));
}

/** Read the last N frames of a file (tails at most maxBytes of it). */
export function readTailFrames(file, count, maxBytes) {
  const size = fs.statSync(file).size;
  const cap = maxBytes === undefined ? 2 * 1048576 : maxBytes;
  const start = size > cap ? size - cap : 0;
  const fb = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fb, buf, 0, buf.length, start);
    let magicOff = buf.lastIndexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
    if (magicOff < 0) return [];
    return tailFrames(buf.subarray(magicOff), count);
  } finally {
    fs.closeSync(fb);
  }
}