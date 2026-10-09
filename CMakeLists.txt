cmake_minimum_required(VERSION 3.16)
project(cpp-trading-agent CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Optimization and security compiler hardening flags
set(CMAKE_CXX_FLAGS_RELEASE "-O3 -Wall -Wextra -pthread -fstack-protector-strong -D_FORTIFY_SOURCE=2")

include_directories(src include)
link_directories(lib)

file(GLOB_RECURSE ENGINE_SOURCES "src/engine/*.cpp" "src/roadmap/*.cpp" "src/common/*.cpp" "src/market_data/*.cpp" "src/analytics/*.cpp")

# Main Executable Target
add_executable(cpp-trading-agent src/main.cpp ${ENGINE_SOURCES})
target_link_libraries(cpp-trading-agent PRIVATE pthread mysqlclient curl ssl crypto)

# Test Suite Executable Target
enable_testing()
add_executable(unit_and_integration_tests tests/unit_and_integration_tests.cpp ${ENGINE_SOURCES})
target_link_libraries(unit_and_integration_tests PRIVATE pthread mysqlclient curl ssl crypto)

add_executable(visitor_analytics_tests tests/visitor_analytics_tests.cpp ${ENGINE_SOURCES})
target_link_libraries(visitor_analytics_tests PRIVATE pthread mysqlclient curl ssl crypto)

add_test(NAME SOLID_ACID_TestSuite COMMAND unit_and_integration_tests)
add_test(NAME Visitor_Analytics_TestSuite COMMAND visitor_analytics_tests)

message(STATUS "C++ Trading Agent & SOLID/ACID Test Suite Built Successfully")
