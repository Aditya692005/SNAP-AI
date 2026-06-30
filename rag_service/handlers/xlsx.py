import json
from pathlib import Path

import pandas as pd

from .base import Parsed, Table


def _engine(path: Path) -> str:
    # openpyxl reads .xlsx; xlrd reads the legacy binary .xls.
    return "xlrd" if path.suffix.lower() == ".xls" else "openpyxl"


def parse(path: Path) -> Parsed:
    xl = pd.ExcelFile(path, engine=_engine(path))
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
