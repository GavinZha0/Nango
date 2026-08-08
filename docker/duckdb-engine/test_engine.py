#!/usr/bin/env python3
"""
Verification Script for nango-duckdb-engine container service.
Tests /health, /v1/extract (standalone & auto UUID mode), auth, preview rows,
and optionally validates the generated Parquet binary file if duckdb is installed locally.
"""

import sys
import os
import json
import urllib.request
import urllib.error

ENGINE_URL = os.getenv("ENGINE_URL", "http://localhost:8526")
SECRET = os.getenv("DUCKDB_APIKEY", "my-local-duckdb-engine-secret")
SHARED_CACHE_DIR = os.getenv("SHARED_CACHE_DIR", "./.cache/datasource/parquet")


def http_request(url: str, method: str = "GET", headers: dict = None, data: dict = None):
    req = urllib.request.Request(url, method=method)
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    
    body_bytes = None
    if data is not None:
        req.add_header("Content-Type", "application/json")
        body_bytes = json.dumps(data).encode("utf-8")
    
    try:
        with urllib.request.urlopen(req, data=body_bytes) as resp:
            resp_bytes = resp.read()
            return resp.status, json.loads(resp_bytes.decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8")
        try:
            return e.code, json.loads(err_body)
        except Exception:
            return e.code, {"error": err_body}


def main():
    print("=== 1. Health Probe Test ===")
    status, res = http_request(f"{ENGINE_URL}/health")
    print(f"Health Response ({status}): {res}")
    assert status == 200 and res.get("status") == "ok", "Health probe failed!"

    print("\n=== 2. Authentication Test (Unauthorized) ===")
    status, res = http_request(f"{ENGINE_URL}/v1/extract", method="POST", data={"query": "SELECT 1"})
    print(f"Auth Test Response ({status}): {res}")
    assert status == 401, "Auth test failed: Unauthenticated request should be rejected!"

    print("\n=== 3. Standalone Extraction Test (Explicit dataset_name) ===")
    headers = {"X-Api-Key": SECRET}
    payload = {
        "dataset_name": "test_sales_q1",
        "provider": "standalone",
        "query": (
            "SELECT 101 AS id, 'MacBook Pro' AS product, 1999.50 AS price, "
            "TRUE AS available, CURRENT_DATE AS created_at"
        ),
        "preview_rows": 5,
        "max_rows": 1000
    }
    status, res = http_request(f"{ENGINE_URL}/v1/extract", method="POST", headers=headers, data=payload)
    print(f"Extract Response ({status}):\n{json.dumps(res, indent=2)}")
    assert status == 200 and res.get("ok") is True, f"Extraction failed: {res}"
    assert res["dataset_name"] == "test_sales_q1"
    assert res["total_rows"] == 1
    assert res["returned_rows"] == 1
    assert len(res["rows"]) == 1
    assert res["rows"][0]["product"] == "MacBook Pro"
    assert "row_schema" in res and len(res["row_schema"]["columns"]) == 5

    output_path = res["output_path"]

    print("\n=== 4. Standalone Extraction Test (Auto-generated UUID dataset_name) ===")
    payload_auto = {
        "provider": "standalone",
        "query": "SELECT i AS row_id FROM range(10) t(i)",
        "preview_rows": 3
    }
    status_auto, res_auto = http_request(f"{ENGINE_URL}/v1/extract", method="POST", headers=headers, data=payload_auto)
    print(f"Auto-UUID Extract Response ({status_auto}):\n{json.dumps(res_auto, indent=2)}")
    assert status_auto == 200 and res_auto.get("ok") is True
    assert res_auto["dataset_name"].startswith("ds_")
    assert res_auto["total_rows"] == 10
    assert res_auto["returned_rows"] == 3

    print("\n=== 5. Local Parquet Binary Verification ===")
    try:
        import duckdb
        local_parquet_path = output_path
        if not os.path.exists(local_parquet_path):
            local_parquet_path = os.path.join(SHARED_CACHE_DIR, "test_sales_q1", "data.parquet")
        
        if os.path.exists(local_parquet_path):
            print(f"Verifying local Parquet file on disk using duckdb: {local_parquet_path}")
            con = duckdb.connect()
            df = con.execute(f"SELECT * FROM read_parquet('{local_parquet_path}')").df()
            print(f"Parquet File Content:\n{df}")
            assert len(df) == 1
            assert df["product"][0] == "MacBook Pro"
            print("Parquet file verification PASSED!")
        else:
            print(f"Note: Local path '{local_parquet_path}' not directly accessible on host. API response verification PASSED!")
    except ImportError:
        print("Note: Python 'duckdb' module not installed locally. Skipped binary inspect step. API response verification PASSED!")

    print("\n✅ ALL DUCKDB ENGINE VERIFICATION TESTS PASSED SUCCESSFULLY!")


if __name__ == "__main__":
    main()
