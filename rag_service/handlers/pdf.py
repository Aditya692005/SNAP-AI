from pathlib import Path

from langchain_community.document_loaders import PyPDFLoader

from .base import Parsed


def parse(path: Path) -> Parsed:
    docs = PyPDFLoader(str(path)).load()
    texts = [d.page_content for d in docs if d.page_content and d.page_content.strip()]
    return Parsed(text_chunks=texts)
