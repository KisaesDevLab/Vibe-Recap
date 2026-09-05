import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Storage } from "../src/services/storage.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "recap-storage-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("storage", () => {
  it("round-trips bytes and stores no plaintext", async () => {
    const s = new Storage(dir);
    await s.init();
    const plain = Buffer.from("%PDF-1.7 hello world SECRET-MARKER " + "x".repeat(5000));
    const blob = await s.put("job-1", plain);
    expect(blob.sha256).toHaveLength(64);
    const onDisk = await fs.readFile(s.abs(blob.path));
    expect(onDisk.includes("SECRET-MARKER")).toBe(false);
    expect(onDisk.subarray(0, 21).toString()).toBe("age-encryption.org/v1");
    const back = await s.get(blob.path, blob.keyPath);
    expect(Buffer.from(back).equals(plain)).toBe(true);
  });

  it("cannot decrypt after shred", async () => {
    const s = new Storage(dir);
    await s.init();
    const blob = await s.put("job-2", Buffer.from("payload"));
    await s.shred(blob.path, blob.keyPath);
    await expect(fs.access(s.abs(blob.path))).rejects.toThrow();
    await expect(fs.access(s.abs(blob.keyPath))).rejects.toThrow();
    await expect(s.get(blob.path, blob.keyPath)).rejects.toThrow();
  });

  it("rotating the master key re-wraps every per-file key", async () => {
    const s = new Storage(dir);
    await s.init();
    const a = await s.put("job-3", Buffer.from("aaa"));
    const b = await s.put("job-4", Buffer.from("bbb"));
    const before = await fs.readFile(s.abs("keys/master.key"), "utf8");
    const { rewrapped } = await s.rotateMasterKey();
    expect(rewrapped).toBe(2);
    const after = await fs.readFile(s.abs("keys/master.key"), "utf8");
    expect(after).not.toBe(before);
    // A fresh instance using only the new master key can still read both blobs.
    const s2 = new Storage(dir);
    await s2.init();
    expect(Buffer.from(await s2.get(a.path, a.keyPath)).toString()).toBe("aaa");
    expect(Buffer.from(await s2.get(b.path, b.keyPath)).toString()).toBe("bbb");
  });

  it("wraps the master key with a passphrase when configured", async () => {
    const s = new Storage(dir, "open-sesame-please");
    await s.init();
    const raw = await fs.readFile(s.abs("keys/master.key"), "utf8");
    expect(raw.startsWith("-----BEGIN AGE ENCRYPTED FILE-----")).toBe(true);
    const blob = await s.put("job-5", Buffer.from("secret"));
    await expect(new Storage(dir).init()).rejects.toThrow(/MASTER_KEY_PASSPHRASE/);
    const s2 = new Storage(dir, "open-sesame-please");
    await s2.init();
    expect(Buffer.from(await s2.get(blob.path, blob.keyPath)).toString()).toBe("secret");
  });

  it("moves blobs between scopes", async () => {
    const s = new Storage(dir);
    await s.init();
    const blob = await s.put("staging/abc", Buffer.from("moved"));
    const moved = await s.move(blob, "job-9");
    expect(moved.path.startsWith("blobs/job-9/")).toBe(true);
    expect(Buffer.from(await s.get(moved.path, moved.keyPath)).toString()).toBe("moved");
  });
});
