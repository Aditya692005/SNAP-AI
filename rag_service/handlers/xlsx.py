import json
from pathlib import Path

import pandas as pd

from .base import Parsed, Table


def _engine(path: Path) -> str:
    # openpyxl reads .xlsx; xlrd reads the legacy binary .xls.
    return "xlrd" if path.suffix.lower() == ".xls" else "openpyxl"


def parse(path: Path) -> Parsed:
    # Close the workbook when done: ExcelFile keeps the file handle open for
    # lazy sheet reads, and on Windows an open handle makes the temp file the
    # /index endpoint parses from undeletable (WinError 32).
    with pd.ExcelFile(path, engine=_engine(path)) as xl:
        tables = []
        for idx, sheet in enumerate(xl.sheet_names):
            df = xl.parse(sheet)
            rows = json.loads(df.to_json(orient="records", date_format="iso"))
            if not rows:
                continue
            tables.append(
                Table(
                    rows=rows,
                    sheet_name=str(sheet),
                    table_name=str(sheet),
                    heading_context=", ".join(str(c) for c in df.columns),
                    table_index=idx,
                )
            )
    return Parsed(tables=tables)
