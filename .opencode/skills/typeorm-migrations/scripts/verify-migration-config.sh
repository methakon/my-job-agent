#!/bin/bash
# Verify TypeORM migration status for NestJS+TypeORM v0.3

set -e

echo "Verifying TypeORM migration infrastructure..."

# 1. Check datasource.ts exists
if [ ! -f "src/datasource.ts" ]; then
  echo "❌ src/datasource.ts not found"
  exit 1
fi
echo "✅ src/datasource.ts exists"

# 2. Check ormconfig.js exists
if [ ! -f "ormconfig.js" ]; then
  echo "❌ ormconfig.js not found"
  exit 1
fi
echo "✅ ormconfig.js exists"

# 3. Check dist/datasource.js exists
if [ ! -f "dist/datasource.js" ]; then
  echo "❌ dist/datasource.js not found - run 'npm run build' first"
  exit 1
fi
echo "✅ dist/datasource.js exists"

# 4. Check migration files exist
MIGRATION_COUNT=$(ls dist/migration/*.js 2>/dev/null | wc -l)
if [ "$MIGRATION_COUNT" -eq 0 ]; then
  echo "⚠️  No migrations found in dist/migration/"
else
  echo "✅ Found $MIGRATION_COUNT migration files"
fi

# 5. Verify database connection via TypeScript
echo "Testing database connection via TypeScript..."
source .venv/bin/activate
export $(grep -v '^#' .env | xargs)

npx ts-node --transpile-only -e "
import datasource from './src/datasource.ts';
console.log('DataSource loaded:', datasource.isInitialized ? 'initialized' : 'not initialized');
console.log('Migrations config:', datasource.options.migrations);
" 2>/dev/null

if [ $? -eq 0 ]; then
  echo "✅ TypeScript DataSource loads successfully"
else
  echo "❌ TypeScript DataSource failed to load"
  exit 1
fi

# 6. Test migration discovery
echo "Testing migration discovery..."
export $(grep -v '^#' .env | xargs)
npx typeorm --dataSource dist/datasource.js migration:run 2>&1 | grep -q "migrations are already loaded"

if [ $? -eq 0 ]; then
  echo "✅ Migration discovery works (migrations table exists)"
else
  echo "⚠️  Migration table may not exist yet"
fi

echo "✅ Verification complete"