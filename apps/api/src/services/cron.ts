import cron, { type ScheduledTask } from "node-cron";
import type { FastifyInstance } from "fastify";

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

  return tasks;
}
