"""Encrypted blob storage, mirroring apps/api/src/services/storage.ts.

Layout under DATA_DIR:
  keys/master.key            age identity, plaintext or passphrase-wrapped (armored)
  blobs/<scope>/<id>.age     blob encrypted to a per-file identity
  blobs/<scope>/<id>.key     that identity, encrypted to the master recipient
"""

from __future__ import annotations

import hashlib
import os
import uuid
from dataclasses import dataclass
from pathlib import Path

import pyrage
from pyrage import passphrase as age_passphrase
from pyrage import x25519


@dataclass(frozen=True)
class StoredBlob:
    id: str
    path: str  # relative, posix
    key_path: str  # relative, posix
    sha256: str
    size: int


class Storage:
    def __init__(self, data_dir: str, master_passphrase: str | None = None):
        self.data_dir = Path(data_dir)
        self.passphrase = master_passphrase
        self._master: x25519.Identity | None = None

    # -- paths -------------------------------------------------------------
    def abs(self, rel: str) -> Path:
        return self.data_dir / rel

    @property
    def blobs_dir(self) -> Path:
        return self.data_dir / "blobs"

    # -- master key ---------------------------------------------------------
    def init(self) -> None:
        key_file = self.data_dir / "keys" / "master.key"
        if not key_file.exists():
            raise FileNotFoundError(f"master key not found at {key_file}; the API creates it on first start")
        raw = key_file.read_text(encoding="utf-8").strip()
        if raw.startswith("AGE-SECRET-KEY-"):
            if self.passphrase:
                raise RuntimeError("MASTER_KEY_PASSPHRASE is set but master.key is not passphrase-wrapped")
            identity_str = raw
        else:
            if not self.passphrase:
                raise RuntimeError("master.key is passphrase-wrapped but MASTER_KEY_PASSPHRASE is not set")
            identity_str = age_passphrase.decrypt(_dearmor(raw), self.passphrase).decode("utf-8").strip()
        self._master = x25519.Identity.from_str(identity_str)

    def _master_identity(self) -> x25519.Identity:
        if self._master is None:
            raise RuntimeError("storage not initialized")
        return self._master

    # -- blobs ---------------------------------------------------------------
    def put(self, scope: str, data: bytes, blob_id: str | None = None) -> StoredBlob:
        master = self._master_identity()
        blob_id = blob_id or str(uuid.uuid4())
        d = self.blobs_dir / scope
        d.mkdir(parents=True, exist_ok=True)
        file_identity = x25519.Identity.generate()
        blob = pyrage.encrypt(data, [file_identity.to_public()])
        wrapped = pyrage.encrypt(str(file_identity).encode("utf-8"), [master.to_public()])
        rel = f"blobs/{scope}/{blob_id}.age"
        rel_key = f"blobs/{scope}/{blob_id}.key"
        _write_private(self.abs(rel_key), wrapped)
        _write_private(self.abs(rel), blob)
        return StoredBlob(blob_id, rel, rel_key, hashlib.sha256(data).hexdigest(), len(data))

    def get(self, rel: str, rel_key: str) -> bytes:
        master = self._master_identity()
        identity_str = pyrage.decrypt(self.abs(rel_key).read_bytes(), [master]).decode("utf-8").strip()
        file_identity = x25519.Identity.from_str(identity_str)
        return pyrage.decrypt(self.abs(rel).read_bytes(), [file_identity])

    def shred(self, rel: str, rel_key: str) -> None:
        key_abs = self.abs(rel_key)
        if key_abs.exists():
            size = key_abs.stat().st_size
            with open(key_abs, "r+b") as fh:
                fh.write(b"\0" * size)
                fh.flush()
                os.fsync(fh.fileno())
            key_abs.unlink()
        blob_abs = self.abs(rel)
        if blob_abs.exists():
            blob_abs.unlink()


def _write_private(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _dearmor(text: str) -> bytes:
    import base64

    lines = [ln.strip() for ln in text.splitlines()]
    body = "".join(ln for ln in lines if ln and not ln.startswith("-----"))
    return base64.b64decode(body)
