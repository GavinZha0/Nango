FROM python:3.13-slim

WORKDIR /app

# Install system utilities if needed (e.g. ca-certificates)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# Shared Volume mount point
ENV SHARED_CACHE_DIR=/cache/parquet
RUN mkdir -p /cache/parquet

EXPOSE 8526

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8526"]
