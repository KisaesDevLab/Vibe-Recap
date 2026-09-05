/**
 * BullMQ producers. The recap queue payload is `{ jobId }` and nothing else: no paths,
 * names, or amounts ever enter Redis. The stage queue carries `{ stageId, fileId }`,
 * also ids only; the worker derives the blob path from them.
 */
import { Queue, QueueEvents, type ConnectionOptions } from "bullmq";
import type { Redis } from "ioredis";

export const RECAP_QUEUE = "recap";
export const STAGE_QUEUE = "recap-stage";

export interface StageResult {
  ok: boolean;
  error?: string;
  firstName?: string | null;
  lastName?: string | null;
  spouseFirstName?: string | null;
  taxYear?: number | null;
  software?: string | null;
  form?: string | null;
  pageCount?: number | null;
  textCoverage?: number | null; // share of pages with a text layer; low means scanned (OCR path)
}

export interface Stager {
  stage(stageId: string, fileId: string, timeoutMs?: number): Promise<StageResult>;
}

export class Queues implements Stager {
  readonly recap: Queue;
  readonly stageQueue: Queue;
  private stageEvents: QueueEvents;

  constructor(redis: Redis) {
    const connection = redis.duplicate() as unknown as ConnectionOptions;
    this.recap = new Queue(RECAP_QUEUE, {
      connection,
      defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 1000, attempts: 1 },
    });
    this.stageQueue = new Queue(STAGE_QUEUE, {
      connection: redis.duplicate() as unknown as ConnectionOptions,
      defaultJobOptions: { removeOnComplete: 500, removeOnFail: 200, attempts: 1 },
    });
    this.stageEvents = new QueueEvents(STAGE_QUEUE, { connection: redis.duplicate() as unknown as ConnectionOptions });
  }

  /** Enqueue a recap job. Uses the job id as the BullMQ id so a job is never queued twice at once. */
  async enqueueRecap(jobId: string): Promise<void> {
    await this.recap.add("recap", { jobId }, { jobId: `${jobId}-${Date.now()}` });
  }

  async stage(stageId: string, fileId: string, timeoutMs = 20_000): Promise<StageResult> {
    const job = await this.stageQueue.add("stage", { stageId, fileId });
    try {
      const result = (await job.waitUntilFinished(this.stageEvents, timeoutMs)) as StageResult;
      return result;
    } catch (err) {
      return { ok: false, error: (err as Error).message.includes("timeout") ? "staging timed out" : (err as Error).message };
    }
  }

  async counts() {
    return this.recap.getJobCounts("waiting", "active", "delayed", "failed");
  }

  async close(): Promise<void> {
    await Promise.all([this.recap.close(), this.stageQueue.close(), this.stageEvents.close()]);
  }
}
