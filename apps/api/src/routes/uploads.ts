import type { FastifyInstance } from "fastify";
import { promises as fs, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { z } from "zod";
import type { StagedFilePatch } from "@vibe-recap/shared";
import { badRequest } from "../errors.js";
import { actorOf, requireRole } from "../plugins/auth.js";
import { isZip, MAX_BATCH_BYTES, MAX_BATCH_FILES, MAX_PDF_BYTES } from "../services/pdfcheck.js";

const patchBody = z.object({
  clientId: z.string().uuid().nullable().optional(),
  newClientName: z.string().max(200).nullable().optional(),
  taxYear: z.number().int().nullable().optional(),
  priorFileId: z.string().uuid().nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
  include: z.boolean().optional(),
});

/** Expand a ZIP on disk into (name, bytes) pairs. Nested folders are flattened; non-PDF entries are reported. */
async function* zipEntries(zipPath: string): AsyncGenerator<{ name: string; data: Buffer | null; reason?: string }> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, z) => (err ? reject(err) : resolve(z))),
  );
  const next = () =>
    new Promise<yauzl.Entry | null>((resolve, reject) => {
      zip.once("entry", (e: yauzl.Entry) => resolve(e));
      zip.once("end", () => resolve(null));
      zip.once("error", reject);
      zip.readEntry();
    });
  let entry: yauzl.Entry | null;
  while ((entry = await next())) {
    const name = path.posix.basename(entry.fileName);
    if (entry.fileName.endsWith("/") || name.startsWith(".") || name.startsWith("__MACOSX")) continue;
    if (!/\.pdf$/i.test(name)) {
      yield { name, data: null, reason: "not a PDF (ignored)" };
      continue;
    }
    if (entry.uncompressedSize > MAX_PDF_BYTES) {
      yield { name, data: null, reason: "larger than 100 MB" };
      continue;
    }
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      zip.openReadStream(entry!, (err, stream) => {
        if (err || !stream) return reject(err ?? new Error("zip stream"));
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", resolve);
        stream.on("error", reject);
      });
    });
    yield { name, data: Buffer.concat(chunks) };
  }
}

export async function uploadRoutes(app: FastifyInstance) {
  /**
   * POST /api/uploads/stage  (multipart)
   * One or many PDFs, or one ZIP of PDFs. Returns the staging table. Nothing is queued yet.
   */
  app.post("/api/uploads/stage", { preHandler: requireRole("staff") }, async (req, reply) => {
    if (!req.isMultipart()) throw badRequest("Expected multipart/form-data");
    const user = req.auth!.user;
    const stage = await app.staging.create(user.id);
    let total = 0;
    let count = 0;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "recap-upload-"));
    try {
      for await (const part of req.files({ limits: { fileSize: MAX_BATCH_BYTES, files: MAX_BATCH_FILES } })) {
        const tmp = path.join(tmpDir, `${count}.bin`);
        await pipeline(part.file, createWriteStream(tmp));
        if (part.file.truncated) throw badRequest("Upload exceeds the 2 GB batch limit");
        const st = await fs.stat(tmp);
        total += st.size;
        if (total > MAX_BATCH_BYTES) throw badRequest("Upload exceeds the 2 GB batch limit");
        const head = Buffer.alloc(4);
        const fh = await fs.open(tmp, "r");
        await fh.read(head, 0, 4, 0);
        await fh.close();
        if (isZip(head)) {
          for await (const e of zipEntries(tmp)) {
            count++;
            if (count > MAX_BATCH_FILES) throw badRequest(`More than ${MAX_BATCH_FILES} files in one upload`);
            if (!e.data) {
              stage.files.push({
                fileId: `skipped-${count}`,
                originalName: e.name,
                sha256: "",
                size: 0,
                status: "skipped",
                skipReason: e.reason,
                role: "source",
                detected: null,
                match: null,
                clientId: null,
                newClientName: null,
                taxYear: null,
                priorFileId: null,
                note: null,
                include: false,
                warnings: [],
                blob: { path: "", keyPath: "", sha256: "", size: 0 },
              });
              continue;
            }
            await app.staging.addFile(stage, e.name, e.data);
          }
        } else {
          count++;
          if (count > MAX_BATCH_FILES) throw badRequest(`More than ${MAX_BATCH_FILES} files in one upload`);
          const data = st.size > MAX_PDF_BYTES ? Buffer.alloc(MAX_PDF_BYTES + 1) : await fs.readFile(tmp);
          await app.staging.addFile(stage, part.filename ?? "upload.pdf", data);
        }
        await fs.rm(tmp, { force: true });
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
    if (count === 0) throw badRequest("No files received");
    const dto = await app.staging.finalize(stage);
    await app.log.info({ stageId: stage.id, files: count, actor: actorOf(req).id }, "upload staged");
    reply.code(201);
    return dto;
  });

  app.get("/api/uploads/stage/:id", { preHandler: requireRole("staff") }, async (req) => {
    const { id } = req.params as { id: string };
    return app.staging.get(id, req.auth!.user.id);
  });

  app.patch("/api/uploads/stage/:id/files/:fileId", { preHandler: requireRole("staff") }, async (req) => {
    const { id, fileId } = req.params as { id: string; fileId: string };
    const body = patchBody.parse(req.body) as StagedFilePatch;
    return app.staging.updateFile(id, req.auth!.user.id, fileId, body);
  });

  app.post("/api/uploads/stage/:id/queue", { preHandler: requireRole("staff") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ note: z.string().max(2000).optional() }).parse(req.body ?? {});
    const actor = actorOf(req);
    const result = await app.staging.queue(id, { id: actor.id!, label: actor.label }, req.ip, body.note);
    reply.code(201);
    return result;
  });
}
