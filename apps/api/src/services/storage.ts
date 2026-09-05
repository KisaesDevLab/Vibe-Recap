/**
 * Encrypted blob storage under DATA_DIR.
 *
 *   /data/keys/master.key        age X25519 identity (optionally passphrase-wrapped, armored)
 *   /data/keys/master.pub        the matching recipient (informational)
 *   /data/blobs/<scope>/<id>.age blob encrypted to a fresh per-file identity
 *   /data/blobs/<scope>/<id>.key that per-file identity, encrypted to the master recipient
 *
 * Shred = overwrite the wrapped key with zeros, fsync, unlink both files. Without the
 * per-file identity the blob is unrecoverable even if the master key survives.
 * The Python worker (recap/storage.py) implements the same layout with pyrage.
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import * as age from "age-encryption";

export interface StoredBlob {
  path: string; // relative to dataDir, posix separators
  keyPath: string; // relative to dataDir, posix separators
  sha256: string;
  size: number;
}

export class Storage {
  private masterIdentity: string | null = null;
  private masterRecipient: string | null = null;

  constructor(
    readonly dataDir: string,
    private passphrase?: string | null,
  ) {}

  get keysDir() {
    return path.join(this.dataDir, "keys");
  }
  get blobsDir() {
    return path.join(this.dataDir, "blobs");
  }
  abs(rel: string) {
    return path.join(this.dataDir, rel);
  }

  /** Load or create the master key. Idempotent. */
  async init(): Promise<void> {
    await fs.mkdir(this.keysDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.blobsDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.dataDir, "orphans"), { recursive: true, mode: 0o700 });
    const keyFile = path.join(this.keysDir, "master.key");
    let identity: string;
    try {
      const raw = await fs.readFile(keyFile);
      identity = await this.unwrapMaster(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      identity = await age.generateIdentity();
      await fs.writeFile(keyFile, await this.wrapMaster(identity), { mode: 0o600 });
    }
    this.masterIdentity = identity;
    this.masterRecipient = await age.identityToRecipient(identity);
    await fs.writeFile(path.join(this.keysDir, "master.pub"), this.masterRecipient + "\n", { mode: 0o600 });
  }

  private async wrapMaster(identity: string, passphrase: string | null | undefined = this.passphrase): Promise<Buffer> {
    if (!passphrase) return Buffer.from(identity + "\n", "utf8");
    const enc = new age.Encrypter();
    enc.setPassphrase(passphrase);
    const bytes = await enc.encrypt(identity);
    return Buffer.from(age.armor.encode(bytes), "utf8");
  }

  private async unwrapMaster(raw: Buffer): Promise<string> {
    const text = raw.toString("utf8").trim();
    if (text.startsWith("AGE-SECRET-KEY-")) {
      if (this.passphrase) {
        throw new Error("MASTER_KEY_PASSPHRASE is set but master.key is not passphrase-wrapped; run rotate-master-key");
      }
      return text;
    }
    if (!this.passphrase) throw new Error("master.key is passphrase-wrapped but MASTER_KEY_PASSPHRASE is not set");
    const dec = new age.Decrypter();
    dec.addPassphrase(this.passphrase);
    return (await dec.decrypt(age.armor.decode(text), "text")).trim();
  }

  private requireMaster() {
    if (!this.masterIdentity || !this.masterRecipient) throw new Error("storage not initialized");
    return { identity: this.masterIdentity, recipient: this.masterRecipient };
  }

  /** Encrypt and store bytes under blobs/<scope>/. Returns relative paths and the plaintext sha256. */
  async put(scope: string, data: Uint8Array, id = randomUUID()): Promise<StoredBlob & { id: string }> {
    const { recipient } = this.requireMaster();
    const dir = path.join(this.blobsDir, scope);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const fileIdentity = await age.generateIdentity();
    const fileRecipient = await age.identityToRecipient(fileIdentity);

    const blobEnc = new age.Encrypter();
    blobEnc.addRecipient(fileRecipient);
    const blob = await blobEnc.encrypt(data);

    const keyEnc = new age.Encrypter();
    keyEnc.addRecipient(recipient);
    const wrapped = await keyEnc.encrypt(fileIdentity);

    const rel = path.posix.join("blobs", scope, `${id}.age`);
    const relKey = path.posix.join("blobs", scope, `${id}.key`);
    await fs.writeFile(this.abs(relKey), wrapped, { mode: 0o600 });
    await fs.writeFile(this.abs(rel), blob, { mode: 0o600 });
    const sha256 = createHash("sha256").update(data).digest("hex");
    return { id, path: rel, keyPath: relKey, sha256, size: data.byteLength };
  }

  async unwrapFileIdentity(relKey: string): Promise<string> {
    const { identity } = this.requireMaster();
    const dec = new age.Decrypter();
    dec.addIdentity(identity);
    return dec.decrypt(await fs.readFile(this.abs(relKey)), "text");
  }

  async get(rel: string, relKey: string): Promise<Uint8Array> {
    const fileIdentity = await this.unwrapFileIdentity(relKey);
    const dec = new age.Decrypter();
    dec.addIdentity(fileIdentity);
    return dec.decrypt(await fs.readFile(this.abs(rel)));
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await fs.access(this.abs(rel));
      return true;
    } catch {
      return false;
    }
  }

  /** Move a blob and its key to another scope (same encryption). */
  async move(blob: StoredBlob, toScope: string): Promise<StoredBlob> {
    const dir = path.join(this.blobsDir, toScope);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const rel = path.posix.join("blobs", toScope, path.posix.basename(blob.path));
    const relKey = path.posix.join("blobs", toScope, path.posix.basename(blob.keyPath));
    await fs.rename(this.abs(blob.keyPath), this.abs(relKey));
    await fs.rename(this.abs(blob.path), this.abs(rel));
    return { ...blob, path: rel, keyPath: relKey };
  }

  /** Overwrite the wrapped key with zeros, then unlink both files. Missing files are ignored. */
  async shred(rel: string, relKey: string): Promise<void> {
    const keyAbs = this.abs(relKey);
    try {
      const st = await fs.stat(keyAbs);
      const fh = await fs.open(keyAbs, "r+");
      try {
        await fh.write(Buffer.alloc(st.size, 0), 0, st.size, 0);
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await fs.rm(keyAbs, { force: true });
    await fs.rm(this.abs(rel), { force: true });
    const dir = path.dirname(this.abs(rel));
    try {
      if ((await fs.readdir(dir)).length === 0) await fs.rmdir(dir);
    } catch {
      /* directory already gone or not empty */
    }
  }

  async removeScope(scope: string): Promise<void> {
    await fs.rm(path.join(this.blobsDir, scope), { recursive: true, force: true });
  }

  /** List every blob path under blobs/ (relative, posix). Used by the orphan check. */
  async listBlobPaths(): Promise<string[]> {
    const files = await this.walk(this.blobsDir, (name) => name.endsWith(".age"));
    return files.map((f) => path.relative(this.dataDir, f).split(path.sep).join("/"));
  }

  /** Generate a new master key and re-wrap every per-file key under blobs/. */
  async rotateMasterKey(newPassphrase: string | null | undefined = this.passphrase): Promise<{ rewrapped: number }> {
    const { identity: oldIdentity } = this.requireMaster();
    const newIdentity = await age.generateIdentity();
    const newRecipient = await age.identityToRecipient(newIdentity);
    let rewrapped = 0;
    for (const keyFile of await this.walk(this.blobsDir, (name) => name.endsWith(".key"))) {
      const dec = new age.Decrypter();
      dec.addIdentity(oldIdentity);
      const fileIdentity = await dec.decrypt(await fs.readFile(keyFile), "text");
      const enc = new age.Encrypter();
      enc.addRecipient(newRecipient);
      await fs.writeFile(keyFile, await enc.encrypt(fileIdentity), { mode: 0o600 });
      rewrapped++;
    }
    await fs.writeFile(path.join(this.keysDir, "master.key"), await this.wrapMaster(newIdentity, newPassphrase), { mode: 0o600 });
    await fs.writeFile(path.join(this.keysDir, "master.pub"), newRecipient + "\n", { mode: 0o600 });
    this.passphrase = newPassphrase ?? null;
    this.masterIdentity = newIdentity;
    this.masterRecipient = newRecipient;
    return { rewrapped };
  }

  private async walk(dir: string, pick: (name: string) => boolean): Promise<string[]> {
    const out: string[] = [];
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await this.walk(p, pick)));
      else if (pick(e.name)) out.push(p);
    }
    return out;
  }
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
