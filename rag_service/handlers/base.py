"""Shared types for the per-file-type document handlers.

Each handler exposes `parse(path) -> Parsed`, returning plain text to embed and
any tabular data to store in document_tables. Handlers do NOT touch the DB or
call the LLM — that's the pipeline's job (so handlers stay simple + testable)."""

from dataclasses import dataclass, field


@dataclass
class Table:
    rows: list                      # list[dict] — JSON-serializable rows
    sheet_name: str | None = None
    table_name: str | None = None
    heading_context: str | None = None  # e.g. the column headers / a caption
    table_index: int = 0


@dataclass
class Parsed:
    text_chunks: list = field(default_factory=list)  # list[str] of raw text
    tables: list = field(default_factory=list)        # list[Table]
