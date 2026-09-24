cmake_minimum_required(VERSION 3.16)
project(cpp-trading-agent CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Optimization and security compiler hardening flags
set(CMAKE_CXX_FLAGS_RELEASE "-O3 -Wall -Wextra -pthread -fstack-protector-strong -D_FORTIFY_SOURCE=2")

include_directories(src)

file(GLOB_RECURSE SOURCES "src/*.cpp")

add_executable(cpp-trading-agent ${SOURCES})

target_link_libraries(cpp-trading-agent PRIVATE pthread mysqlclient)

message(STATUS "C++ Trading Agent Target Built Successfully")
