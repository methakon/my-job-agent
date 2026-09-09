#!/bin/bash
# Run pending TypeORM migrations for NestJS+TypeORM v0.3

set -e

echo "Running TypeORM migrations..."

# Load environment
export $(grep -v '^#' .env | xargs)

# Run migrations
npx typeorm --dataSource dist/datasource.js migration:run

echo "✅ Migrations completed"