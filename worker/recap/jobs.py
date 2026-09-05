"""BullMQ consumer entry point.

Two queues:
  recap        {"jobId"}            the pipeline; concurrency = WORKER_CONCURRENCY (default 1)
  recap-stage  {"stageId","fileId"} upload-time first-page pass; concurrency 4, always responsive

Pipeline steps run in a thread so staging keeps answering while a job renders.
"""

from __future__ import annotations

import asyncio
import signal

from bullmq import Worker
import redis.asyncio as aioredis

from .config import Config
from .logging import configure, get_logger
from .storage import Storage

QUEUE_NAME = "recap"
STAGE_QUEUE_NAME = "recap-stage"


class App:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.storage = Storage(cfg.data_dir, cfg.master_key_passphrase)
        self.log = get_logger("recap.jobs")

    async def process_recap(self, job, token: str | None = None):  # noqa: ANN001
        from .pipeline import run_job

        job_id = job.data.get("jobId")
        log = get_logger("recap.jobs", job_id=job_id)
        log.info("job received")
        return await asyncio.to_thread(run_job, self.cfg, self.storage, job_id)

    async def process_stage(self, job, token: str | None = None):  # noqa: ANN001
        from .stage import stage_file

        data = job.data or {}
        return await asyncio.to_thread(stage_file, self.cfg, self.storage, str(data.get("stageId")), str(data.get("fileId")))


async def wait_for_redis(url: str, attempts: int = 60) -> None:
    client = aioredis.from_url(url)
    try:
        for _ in range(attempts):
            try:
                await client.ping()
                return
            except Exception:  # noqa: BLE001
                await asyncio.sleep(2)
        raise SystemExit("redis unreachable")
    finally:
        await client.aclose()


async def wait_for_master_key(storage: Storage, log, attempts: int = 120) -> None:  # noqa: ANN001
    for _ in range(attempts):
        try:
            storage.init()
            return
        except FileNotFoundError:
            log.info("waiting for master key (API creates it on first start)")
            await asyncio.sleep(3)
    raise SystemExit("master key never appeared")


async def main() -> None:
    cfg = Config.from_env()
    configure(cfg.log_level)
    app = App(cfg)
    await wait_for_redis(cfg.redis_url)
    await wait_for_master_key(app.storage, app.log)

    recap_worker = Worker(QUEUE_NAME, app.process_recap, {"connection": cfg.redis_url, "concurrency": cfg.concurrency})
    stage_worker = Worker(STAGE_QUEUE_NAME, app.process_stage, {"connection": cfg.redis_url, "concurrency": 4})
    app.log.info("connected to redis, waiting", extra={"queue": QUEUE_NAME, "concurrency": cfg.concurrency})

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # Windows
            signal.signal(sig, lambda *_: stop.set())
    await stop.wait()
    app.log.info("shutting down")
    await asyncio.gather(recap_worker.close(), stage_worker.close())


if __name__ == "__main__":
    asyncio.run(main())
