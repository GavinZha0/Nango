#!/bin/sh
set -e

echo "Running database migrations..."
node docker/migrate.mjs

echo "Starting application..."
exec node server.js
