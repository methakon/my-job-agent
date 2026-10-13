cmake_minimum_required(VERSION 3.16)
project(cpp-trading-agent CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Optimization and security compiler hardening flags
set(CMAKE_CXX_FLAGS_RELEASE "-O3 -Wall -Wextra -pthread -fstack-protector-strong -D_FORTIFY_SOURCE=2")

include_directories(src include)
link_directories(lib)

# Inject the exact build revision so every decision row can be traced to the code that produced
# it. Previously all three call sites carried the literal "f8c24c3", so every one of 245,350
# journal rows was stamped with the same stale SHA and the field identified nothing.
execute_process(
    COMMAND git rev-parse --short HEAD
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
    OUTPUT_VARIABLE HERMES_GIT_SHA
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET
)
if(NOT HERMES_GIT_SHA)
    set(HERMES_GIT_SHA "unknown")
endif()
# A dirty tree means the binary does not correspond to any commit - say so rather than
# claiming a revision that was not what got built.
execute_process(
    COMMAND git status --porcelain --untracked-files=no
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
    OUTPUT_VARIABLE HERMES_GIT_DIRTY
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET
)
if(HERMES_GIT_DIRTY)
    set(HERMES_GIT_SHA "${HERMES_GIT_SHA}-dirty")
endif()
message(STATUS "Build revision (HERMES_BUILD_GIT_SHA): ${HERMES_GIT_SHA}")
add_compile_definitions(HERMES_BUILD_GIT_SHA="${HERMES_GIT_SHA}")

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
