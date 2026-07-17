"""Original document bytes, fetched from Supabase Storage.

The uploaded file used to live on this service's local disk (./uploads), which made the
service stateful: redeploy it, or run a second copy, and every original was gone — taking
chart refreshes, metric extraction and downloads with it. The bucket is now the store of
record and this module is the only thing that knows it exists.

Disk survives only as a CACHE. Deleting CACHE_DIR at any moment is safe; the next call
that needs a file re-downloads it. Nothing here is ever the last copy of anything.

The parsers all want a real filesystem path (`parse_file`, `pd.read_csv`,
`pd.read_excel`), and metric extraction re-reads whole multi-MB PDFs, so we materialize
to a file rather than streaming a BytesIO on every call.
"""

import os
import shutil
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

import supabase_store as store

BUCKET = os.getenv("SUPABASE_BUCKET", "documents")

# Disposable. Not ./uploads — that name meant "the files", and this is a cache.
CACHE_DIR = Path("./.cache/documents")
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _bucket():
    return store.sb().storage.from_(BUCKET)


def _cache_path(storage_path: str) -> Path:
    """Mirror the storage key under CACHE_DIR. The key is already org/document scoped,
    so two tenants' same-named files can't collide here either."""
    return CACHE_DIR / storage_path


def fetch(storage_path: str) -> Path | None:
    """Local path to the object at `storage_path`, downloading it on a cache miss."""
    dest = _cache_path(storage_path)
    if dest.is_file() and dest.stat().st_size > 0:
        return dest

    try:
        data = _bucket().download(storage_path)
    except Exception as exc:  # object gone, bad key, or no service-role credentials
        print(f"[storage] could not fetch '{storage_path}': {exc}")
        return None

    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return dest


def resolve_source(
    source: str | None = None,
    document_id: str | None = None,
    organization_id: str | None = None,
) -> Path | None:
    """Local path to a document's ORIGINAL bytes — the entry point for every caller
    that used to build `UPLOAD_DIR / source`.

    Prefer `document_id`: it identifies the document exactly. `source` (a file name) is
    all some callers have — a pinned chart widget, a cited source in the chat — and it is
    only safe alongside `organization_id`, which keeps the lookup inside the caller's own
    tenant. The path-traversal guards the old disk lookups needed are gone with them: the
    key now comes from a database column, never from the request.
    """
    found = store.storage_path_for(
        document_id=document_id, file_name=source, organization_id=organization_id
    )
    if not found:
        return None
    storage_path, _ = found
    return fetch(storage_path)


def put_generated(organization_id: str, file_name: str, path: Path) -> str:
    """Upload an AI-generated report and return its storage key.

    Generated reports get their own `generated/` prefix because they exist as files
    before any documents row does — one is only created if the user clicks "Add to AI".
    Org-scoped, which is what makes it safe for the backend to serve one by name alone.
    """
    key = f"generated/{organization_id}/{file_name}"
    _bucket().upload(
        key,
        path.read_bytes(),
        {"content-type": "application/pdf", "upsert": "true"},
    )
    return key


def evict(file_name: str | None = None) -> int:
    """Drop cached copies. Called when a document is deleted — the bucket object and the
    row are the backend's job; this just stops us serving a stale local copy.

    Without a file name, empties the whole cache. With one, removes every cached file of
    that name across all document folders (the cache is keyed by storage path, and a
    caller deleting a document only tells us its name)."""
    removed = 0
    if file_name is None:
        if CACHE_DIR.is_dir():
            removed = sum(1 for _ in CACHE_DIR.rglob("*") if _.is_file())
            shutil.rmtree(CACHE_DIR, ignore_errors=True)
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        return removed

    for path in CACHE_DIR.rglob(Path(file_name).name):
        if path.is_file():
            try:
                path.unlink()
                removed += 1
            except OSError:
                pass
    return removed
