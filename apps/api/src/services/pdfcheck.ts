/** Cheap byte-level PDF checks used at upload time. The worker does the real parsing. */

export const PDF_MAGIC = Buffer.from("%PDF-");
export const MAX_PDF_BYTES = 100 * 1024 * 1024;
export const MAX_BATCH_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_BATCH_FILES = 200;

export function isPdf(buf: Uint8Array): boolean {
  const head = Buffer.from(buf.subarray(0, 1024));
  return head.indexOf(PDF_MAGIC) !== -1 && head.indexOf(PDF_MAGIC) < 512;
}

/**
 * True when the file carries an /Encrypt dictionary in a trailer or xref stream.
 * Scans the tail first (where trailers live), then the whole file for incremental updates.
 */
export function isEncryptedPdf(buf: Uint8Array): boolean {
  const b = Buffer.from(buf);
  const tail = b.subarray(Math.max(0, b.length - 64 * 1024));
  if (/\/Encrypt\s*(\d+\s+\d+\s+R|<<)/.test(tail.toString("latin1"))) return true;
  return /\/Encrypt\s*(\d+\s+\d+\s+R|<<)/.test(b.toString("latin1"));
}

export function isZip(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}
