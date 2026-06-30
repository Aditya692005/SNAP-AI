"""Per-file-type document handlers.

`parse_file(path)` dispatches to the handler for the file's extension and
returns a `Parsed` (text_chunks + tables). One module per type keeps each
parser small and independently debuggable."""

from pathlib import Path

from . import csv, docx, pdf, pptx, txt, xlsx
from .base import Parsed, Table

ALLOWED_EXTENSIONS = {".pdf", ".csv", ".txt", ".xlsx", ".xls", ".docx", ".pptx"}

_HANDLERS = {
    ".pdf": pdf.parse,
    ".csv": csv.parse,
    ".txt": txt.parse,
    ".xlsx": xlsx.parse,
    ".xls": xlsx.parse,
    ".docx": docx.parse,
    ".pptx": pptx.parse,
}


def parse_file(path: Path) -> Parsed:
    handler = _HANDLERS.get(path.suffix.lower())
    if handler is None:
        raise ValueError(f"Unsupported file type: {path.suffix}")
    return handler(path)


__all__ = ["parse_file", "Parsed", "Table", "ALLOWED_EXTENSIONS"]
