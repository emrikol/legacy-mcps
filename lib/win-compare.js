/**
 * win-compare.js — BMP Screenshot Comparison
 *
 * Compares two 24-bit BMP files pixel-by-pixel and returns a similarity score.
 * Designed for comparing Windows 3.x screenshots captured by GDI CAPTURE.
 *
 * Usage:
 *   const { compareBmp, loadBmp } = require('./win-compare');
 *   const result = compareBmp('reference.bmp', 'actual.bmp');
 *   console.log(result.similarity); // 0.0 to 1.0
 *   console.log(result.match);      // true if above threshold
 *
 * @module win-compare
 */

'use strict';

const fs = require('fs');

/**
 * Parse a 24-bit BMP file into raw pixel data.
 * @param {string|Buffer} input - File path or Buffer
 * @returns {{ width: number, height: number, pixels: Buffer }} RGB pixel data (top-to-bottom)
 */
function loadBmp(input) {
  const buf = typeof input === 'string' ? fs.readFileSync(input) : input;

  // BMP header validation
  if (buf[0] !== 0x42 || buf[1] !== 0x4D) {
    throw new Error('Not a BMP file');
  }

  const dataOffset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const height = Math.abs(buf.readInt32LE(22));
  const bpp = buf.readUInt16LE(28);
  const topDown = buf.readInt32LE(22) < 0;

  if (bpp !== 24) {
    throw new Error(`Unsupported BMP format: ${bpp}bpp (expected 24)`);
  }

  // Each row is padded to 4-byte boundary
  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const pixels = Buffer.alloc(width * height * 3);

  for (let row = 0; row < height; row++) {
    // BMP stores bottom-up by default
    const srcRow = topDown ? row : (height - 1 - row);
    const srcOffset = dataOffset + srcRow * rowBytes;
    const dstOffset = row * width * 3;

    for (let col = 0; col < width; col++) {
      const si = srcOffset + col * 3;
      const di = dstOffset + col * 3;
      // BMP stores BGR, convert to RGB
      pixels[di + 0] = buf[si + 2]; // R
      pixels[di + 1] = buf[si + 1]; // G
      pixels[di + 2] = buf[si + 0]; // B
    }
  }

  return { width, height, pixels };
}

/**
 * Compare two BMP files pixel-by-pixel.
 *
 * @param {string|Buffer} reference - Reference BMP (file path or Buffer)
 * @param {string|Buffer} actual - Actual BMP (file path or Buffer)
 * @param {object} [opts]
 * @param {number} [opts.threshold=0.95] - Similarity threshold for match (0.0 to 1.0)
 * @param {number} [opts.pixelTolerance=0] - Per-channel tolerance (0-255) for fuzzy matching
 * @returns {{ match: boolean, similarity: number, totalPixels: number, matchingPixels: number, differentPixels: number, sameSize: boolean }}
 */
function compareBmp(reference, actual, opts = {}) {
  const threshold = opts.threshold !== undefined ? opts.threshold : 0.95;
  const tolerance = opts.pixelTolerance || 0;

  const ref = loadBmp(reference);
  const act = loadBmp(actual);

  const sameSize = ref.width === act.width && ref.height === act.height;

  if (!sameSize) {
    return {
      match: false,
      similarity: 0,
      totalPixels: ref.width * ref.height,
      matchingPixels: 0,
      differentPixels: ref.width * ref.height,
      sameSize: false,
    };
  }

  const totalPixels = ref.width * ref.height;
  let matchingPixels = 0;

  for (let i = 0; i < totalPixels; i++) {
    const offset = i * 3;
    const dr = Math.abs(ref.pixels[offset] - act.pixels[offset]);
    const dg = Math.abs(ref.pixels[offset + 1] - act.pixels[offset + 1]);
    const db = Math.abs(ref.pixels[offset + 2] - act.pixels[offset + 2]);

    if (dr <= tolerance && dg <= tolerance && db <= tolerance) {
      matchingPixels++;
    }
  }

  const similarity = matchingPixels / totalPixels;

  return {
    match: similarity >= threshold,
    similarity,
    totalPixels,
    matchingPixels,
    differentPixels: totalPixels - matchingPixels,
    sameSize: true,
  };
}

module.exports = { loadBmp, compareBmp };
