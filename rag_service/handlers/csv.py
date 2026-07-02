import json
from pathlib import Path

import pandas as pd

from .base import Parsed, Table


def parse(path: Path) -> Parsed:
    df = pd.read_csv(path)
    # to_json handles NaN -> null and numpy/Timestamp types, giving clean
    # JSON-serializable rows for the jsonb column.
    rows = json.loads(df.to_json(orient="records", date_format="iso"))
    if not rows:
        return Parsed()
    table = Table(
        rows=rows,
        sheet_name=None,
        table_name=path.stem,
        heading_context=", ".join(str(c) for c in df.columns),
        table_index=0,
    )
    return Parsed(tables=[table])
