import os
import sys
import uuid
import datetime
import decimal
import logging
from typing import Optional, Dict, Any, List
import duckdb
from fastapi import FastAPI, HTTPException, Header, Depends
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("duckdb-engine")

app = FastAPI(
    title="Nango DuckDB Engine",
    description="Isolated DuckDB Data Extraction & Parquet Generation Worker Service",
    version="1.0.0",
)

WORKER_SECRET = os.getenv("DUCKDB_APIKEY", "my-local-duckdb-engine-secret")
SHARED_CACHE_DIR = os.getenv("SHARED_CACHE_DIR", "/cache/parquet")


@app.on_event("startup")
def on_startup():
    logger.info("==================================================")
    logger.info("🚀 Nango DuckDB Engine Service Started")
    logger.info(f"🐍 Python Version : {sys.version.split()[0]} ({sys.executable})")
    logger.info(f"🦆 DuckDB Version : {duckdb.__version__}")
    logger.info(f"📁 Cache Directory: {SHARED_CACHE_DIR}")
    logger.info("==================================================")


class ExtractRequest(BaseModel):
    query: str = Field(..., description="SQL query string to execute and export")
    dataset_name: Optional[str] = Field(
        None,
        description="Cache slot dataset name. Auto-generates a UUID if missing.",
    )
    provider: str = Field(
        "standalone",
        description="Data provider type: 'standalone' | 'postgres' | 'mysql' | 's3'",
    )
    config: Dict[str, Any] = Field(
        default_factory=dict,
        description="Provider-specific configuration parameters",
    )
    preview_rows: int = Field(
        5, ge=0, le=200, description="Number of inline preview rows to return"
    )
    max_rows: int = Field(
        500000, ge=1, description="Hard cap on maximum rows allowed to export"
    )


def verify_secret(
    x_duckdb_api_key: Optional[str] = Header(None, alias="X-DuckDB-Api-Key"),
    x_api_key: Optional[str] = Header(None, alias="X-Api-Key"),
):
    key = x_duckdb_api_key or x_api_key
    if key != WORKER_SECRET:
        raise HTTPException(
            status_code=401, detail="Unauthorized: Invalid or missing X-DuckDB-Api-Key"
        )


def escape_sql_str(s: str) -> str:
    return s.replace("'", "''")


def quote_ident(s: str) -> str:
    return f'"{s.replace('"', '""')}"'


def map_duckdb_type(t: str) -> str:
    u = t.upper()
    if u == "BOOLEAN":
        return "bool"
    if u in ("INTEGER", "INT4", "INT32"):
        return "int32"
    if u in ("BIGINT", "INT8", "HUGEINT", "INT64"):
        return "int64"
    if u in ("FLOAT", "REAL", "FLOAT4"):
        return "float32"
    if u in ("DOUBLE", "FLOAT8"):
        return "float64"
    if u.startswith("DECIMAL"):
        return "decimal"
    if u == "DATE":
        return "date"
    if u.startswith("TIMESTAMP"):
        return "timestamp"
    if u in ("VARCHAR", "TEXT", "STRING"):
        return "string"
    if u in ("BLOB", "BYTEA"):
        return "binary"
    return "string"


def json_serialize_cell(val: Any) -> Any:
    if val is None:
        return None
    if isinstance(val, (datetime.date, datetime.datetime, datetime.time)):
        return val.isoformat()
    if isinstance(val, decimal.Decimal):
        return float(val)
    if isinstance(val, bytes):
        return val.hex()
    return val


@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "duckdb-engine", "version": "1.0.0"}


@app.post("/v1/extract", dependencies=[Depends(verify_secret)])
async def extract_dataset(req: ExtractRequest):
    dataset_name = req.dataset_name or f"ds_{uuid.uuid4().hex[:12]}"
    
    # Ensure cache directory for this dataset exists
    dataset_dir = os.path.join(SHARED_CACHE_DIR, dataset_name)
    os.makedirs(dataset_dir, exist_ok=True)
    output_path = os.path.join(dataset_dir, "data.parquet")

    db = duckdb.connect(":memory:")
    try:
        provider = req.provider.lower()
        cfg = req.config or {}

        # 1. Configure Providers
        if provider in ("postgres", "mysql"):
            host = cfg.get("host", "localhost")
            port = cfg.get("port", 5432 if provider == "postgres" else 3306)
            user = cfg.get("user") or cfg.get("username") or ""
            password = cfg.get("password", "")
            database = cfg.get("database", "")
            schema_name = cfg.get("schema", "public")

            db.execute(f"INSTALL {provider}; LOAD {provider};")

            if provider == "postgres":
                conn_str = f"host={host} port={port} dbname={database} user={user} password={password}"
            else:  # mysql
                conn_str = f"host={host} port={port} database={database} user={user} password={password}"

            attach_sql = (
                f"ATTACH '{escape_sql_str(conn_str)}' AS src "
                f"(TYPE {provider.upper()}, READ_ONLY);"
            )
            db.execute(attach_sql)

            if schema_name:
                db.execute(f"USE src.{quote_ident(schema_name)};")

        elif provider == "s3":
            db.execute("INSTALL httpfs; LOAD httpfs;")
            if "region" in cfg:
                db.execute(f"SET s3_region = '{escape_sql_str(str(cfg['region']))}';")
            if "access_key_id" in cfg:
                db.execute(f"SET s3_access_key_id = '{escape_sql_str(str(cfg['access_key_id']))}';")
            if "secret_access_key" in cfg:
                db.execute(f"SET s3_secret_access_key = '{escape_sql_str(str(cfg['secret_access_key']))}';")
            if "endpoint" in cfg:
                db.execute(f"SET s3_endpoint = '{escape_sql_str(str(cfg['endpoint']))}';")
            if "use_ssl" in cfg:
                use_ssl_str = "true" if cfg["use_ssl"] else "false"
                db.execute(f"SET s3_use_ssl = {use_ssl_str};")

        elif provider != "standalone":
            raise HTTPException(
                status_code=400, detail=f"Unsupported provider: '{req.provider}'"
            )

        # 2. Execute Copy Query
        copy_sql = (
            f"COPY ({req.query}) TO '{escape_sql_str(output_path)}' "
            f"(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000);"
        )
        db.execute(copy_sql)

        # 3. Introspect Schema & Row Count
        esc_path = escape_sql_str(output_path)
        desc_res = db.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{esc_path}')"
        ).fetchall()
        
        columns = [
            {
                "name": str(col[0]),
                "type": map_duckdb_type(str(col[1])),
                "nullable": str(col[2]).upper() == "YES",
            }
            for col in desc_res
        ]

        count_res = db.execute(
            f"SELECT count(*) FROM read_parquet('{esc_path}')"
        ).fetchone()
        total_rows = int(count_res[0]) if count_res else 0

        if total_rows > req.max_rows:
            # Clean up oversize file
            if os.path.exists(output_path):
                os.remove(output_path)
            raise HTTPException(
                status_code=400,
                detail=f"Extracted {total_rows} rows exceeds max_rows={req.max_rows}.",
            )

        byte_size = os.path.getsize(output_path) if os.path.exists(output_path) else 0

        # 4. Preview Rows
        rows: List[Dict[str, Any]] = []
        if req.preview_rows > 0 and total_rows > 0:
            limit = min(req.preview_rows, 200)
            preview_rel = db.execute(
                f"SELECT * FROM read_parquet('{esc_path}') LIMIT {limit}"
            )
            col_names = [desc[0] for desc in preview_rel.description]
            raw_rows = preview_rel.fetchall()
            for raw_row in raw_rows:
                row_dict = {}
                for idx, cell_val in enumerate(raw_row):
                    row_dict[col_names[idx]] = json_serialize_cell(cell_val)
                rows.append(row_dict)

        return {
            "ok": True,
            "dataset_name": dataset_name,
            "output_path": output_path,
            "total_rows": total_rows,
            "returned_rows": len(rows),
            "byte_size": byte_size,
            "rows": rows,
            "row_schema": {"columns": columns},
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"DuckDB extraction error: {str(e)}")
    finally:
        db.close()
