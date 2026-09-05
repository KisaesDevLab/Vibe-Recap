import pyrage
from pyrage import x25519

from recap.storage import Storage


def make_master(tmp_path):
    (tmp_path / "keys").mkdir()
    ident = x25519.Identity.generate()
    (tmp_path / "keys" / "master.key").write_text(str(ident) + "\n")
    return ident


def test_round_trip_and_no_plaintext(tmp_path):
    make_master(tmp_path)
    s = Storage(str(tmp_path))
    s.init()
    data = b"%PDF-1.7 SECRET-MARKER " + b"x" * 4000
    blob = s.put("job-a", data)
    on_disk = (tmp_path / blob.path).read_bytes()
    assert b"SECRET-MARKER" not in on_disk
    assert on_disk.startswith(b"age-encryption.org/v1")
    assert s.get(blob.path, blob.key_path) == data
    assert len(blob.sha256) == 64


def test_shred_makes_blob_unrecoverable(tmp_path):
    make_master(tmp_path)
    s = Storage(str(tmp_path))
    s.init()
    blob = s.put("job-b", b"payload")
    s.shred(blob.path, blob.key_path)
    assert not (tmp_path / blob.path).exists()
    assert not (tmp_path / blob.key_path).exists()


def test_interop_with_node_layout(tmp_path):
    """A key wrapped by any age implementation to the master recipient decrypts here."""
    ident = make_master(tmp_path)
    s = Storage(str(tmp_path))
    s.init()
    file_ident = x25519.Identity.generate()
    blob = pyrage.encrypt(b"from-node", [file_ident.to_public()])
    wrapped = pyrage.encrypt(str(file_ident).encode(), [ident.to_public()])
    d = tmp_path / "blobs" / "job-c"
    d.mkdir(parents=True)
    (d / "f.age").write_bytes(blob)
    (d / "f.key").write_bytes(wrapped)
    assert s.get("blobs/job-c/f.age", "blobs/job-c/f.key") == b"from-node"
