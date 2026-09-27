#!/bin/bash
set -e

echo "==================================================================="
echo "🛡️ [CI MERGE GUARD] RUNNING COMPREHENSIVE SUITE FOR ENGINE & RISK"
echo "==================================================================="

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

# 1. Compile unit and integration tests
echo "🔨 Compiling test suite with C++20 -O3..."
/usr/bin/g++ -O3 -std=c++20 -pthread tests/unit_and_integration_tests.cpp src/engine/*.cpp src/roadmap/*.cpp src/common/*.cpp -lmysqlclient -o bin/unit_and_integration_tests

# 2. Execute test suite
echo "🧪 Running unit and integration tests..."
./bin/unit_and_integration_tests

echo "✅ [CI MERGE GUARD] PASS: All SOLID, ACID, and Gate 0 Invariants Verified!"
