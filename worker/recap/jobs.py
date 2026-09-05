"""BullMQ consumer entry point. Phase 1: connect to Redis and idle.

Queue name must be exactly "recap" and the payload is {"jobId": "..."} only.
"""

from __future__ import annotations

import asyncio
import signal

from bullmq import Worker
import redis.asyncio as aioredis

from .config import Config
from .logging import configure, get_logger

QUEUE_NAME = "recap"


async def process(job, token: str | None = None):  # noqa: ANN001
    log = get_logger("recap.jobs", job_id=job.data.get("jobId"))
    log.warning("pipeline not implemented yet; job left for a later phase")
    raise RuntimeError("pipeline not implemented")


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


async def main() -> None:
    cfg = Config.from_env()
    configure(cfg.log_level)
    log = get_logger("recap.jobs")
    await wait_for_redis(cfg.redis_url)

    worker = Worker(QUEUE_NAME, process, {"connection": cfg.redis_url, "concurrency": cfg.concurrency})
    log.info("connected to redis, waiting", extra={"queue": QUEUE_NAME, "concurrency": cfg.concurrency})

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # Windows
            signal.signal(sig, lambda *_: stop.set())
    await stop.wait()
    log.info("shutting down")
    await worker.close()


if __name__ == "__main__":
    asyncio.run(main())
