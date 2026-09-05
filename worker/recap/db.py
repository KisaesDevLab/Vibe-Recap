"""Thin psycopg helpers for the worker. Only job ids and hashes are logged; rows may hold PII."""

from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row


class Db:
    def __init__(self, url: str):
        self.url = url

    @contextmanager
    def conn(self) -> Iterator[psycopg.Connection]:
        with psycopg.connect(self.url, row_factory=dict_row, autocommit=True) as c:
            yield c

    # -- jobs ----------------------------------------------------------------
    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self.conn() as c:
            return c.execute("select * from jobs where id = %s", (job_id,)).fetchone()

    def update_job(self, job_id: str, **fields: Any) -> None:
        if not fields:
            return
        cols = ", ".join(f"{k} = %s" for k in fields)
        vals = [json.dumps(v) if isinstance(v, (dict, list)) else v for v in fields.values()]
        with self.conn() as c:
            c.execute(f"update jobs set {cols}, updated_at = now() where id = %s", (*vals, job_id))

    def add_event(self, job_id: str, status: str, step: str | None = None, message: str | None = None, meta: dict | None = None) -> None:
        with self.conn() as c:
            c.execute(
                "insert into job_events (job_id, step, status, message, meta) values (%s, %s, %s, %s, %s::jsonb)",
                (job_id, step, status, message, json.dumps(meta or {})),
            )

    # -- files ---------------------------------------------------------------
    def list_files(self, job_id: str, kind: str | None = None) -> list[dict[str, Any]]:
        with self.conn() as c:
            if kind:
                return c.execute(
                    "select * from files where job_id = %s and kind = %s and purged_at is null order by seq, created_at",
                    (job_id, kind),
                ).fetchall()
            return c.execute("select * from files where job_id = %s and purged_at is null order by kind, seq", (job_id,)).fetchall()

    def add_file(self, job_id: str, kind: str, path: str, key_path: str, sha256: str, size: int, seq: int = 0, file_id: str | None = None) -> str:
        with self.conn() as c:
            row = c.execute(
                "insert into files (id, job_id, kind, path, key_path, sha256, size, seq) values (coalesce(%s::uuid, gen_random_uuid()), %s, %s, %s, %s, %s, %s, %s) returning id",
                (file_id, job_id, kind, path, key_path, sha256, size, seq),
            ).fetchone()
            return str(row["id"])

    def delete_files(self, job_id: str, kinds: list[str]) -> list[dict[str, Any]]:
        """Remove file rows of the given kinds (caller shreds blobs). Returns removed rows."""
        with self.conn() as c:
            return c.execute(
                "delete from files where job_id = %s and kind = any(%s) returning *", (job_id, kinds)
            ).fetchall()

    # -- settings / clients --------------------------------------------------
    def settings(self) -> dict[str, Any]:
        with self.conn() as c:
            rows = c.execute("select key, value from settings").fetchall()
        return {r["key"]: r["value"] for r in rows}

    def get_client(self, client_id: str) -> dict[str, Any] | None:
        with self.conn() as c:
            return c.execute("select * from clients where id = %s", (client_id,)).fetchone()

    def audit(self, action: str, target_type: str, target_id: str, meta: dict | None = None, actor_label: str = "system:worker") -> None:
        with self.conn() as c:
            c.execute(
                "insert into audit_events (actor_id, actor_label, action, target_type, target_id, meta) values (null, %s, %s, %s, %s, %s::jsonb)",
                (actor_label, action, target_type, target_id, json.dumps(meta or {})),
            )
