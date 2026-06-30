from pathlib import Path

from .base import Parsed


def parse(path: Path) -> Parsed:
    text = path.read_text(encoding="utf-8", errors="ignore")
    return Parsed(text_chunks=[text] if text.strip() else [])
