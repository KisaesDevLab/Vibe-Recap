import cron, { type ScheduledTask } from "node-cron";
import type { FastifyInstance } from "fastify";
import { runPurge } from "./purge.js";

/** Scheduled jobs inside the API. Every job logs start/finish with counts only. */
export function startCron(app: FastifyInstance): ScheduledTask[] {
  const tasks: ScheduledTask[] = [];

  tasks.push(
    cron.schedule("*/10 * * * *", async () => {
      try {
        const removed = await app.staging.sweepExpired();
        if (removed) app.log.info({ removed }, "staging sweep");
      } catch (err) {
        app.log.error({ err }, "staging sweep failed");
      }
    }),
  );

  // Hourly retention purge: the only thing that deletes files (CLAUDE.md non-negotiable 5).
  tasks.push(
    cron.schedule("7 * * * *", async () => {
      try {
        const r = await runPurge(app);
        app.log.info({ purgedFiles: r.purgedFiles, purgedJobs: r.purgedJobs, skippedLegalHold: r.skippedLegalHold }, "retention purge");
      } catch (err) {
        app.log.error({ err }, "retention purge failed");
      }
    }),
  );

  return tasks;
}
