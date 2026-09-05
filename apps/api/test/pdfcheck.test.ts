import { describe, expect, it } from "vitest";
import { isEncryptedPdf, isPdf, isZip } from "../src/services/pdfcheck.js";

describe("pdfcheck", () => {
  it("detects the PDF magic", () => {
    expect(isPdf(Buffer.from("%PDF-1.7\n%âãÏÓ\n"))).toBe(true);
    expect(isPdf(Buffer.from("hello"))).toBe(false);
    expect(isPdf(Buffer.from("\n\n%PDF-1.4"))).toBe(true);
  });
  it("detects encrypted PDFs by the /Encrypt trailer entry", () => {
    const plain = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");
    const enc = Buffer.from("%PDF-1.4\n1 0 obj<</Filter/Standard>>endobj\ntrailer<</Root 2 0 R/Encrypt 1 0 R>>\n%%EOF");
    expect(isEncryptedPdf(plain)).toBe(false);
    expect(isEncryptedPdf(enc)).toBe(true);
  });
  it("detects zip magic", () => {
    expect(isZip(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]))).toBe(true);
    expect(isZip(Buffer.from("%PDF-"))).toBe(false);
  });
});
