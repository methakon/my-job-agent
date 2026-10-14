#pragma once

// Explicit test-mode database configuration.
//
// There are deliberately NO defaults. The values that used to be defaults in the harness -
// 127.0.0.1:3307, user `mylife`, schema `myjob_agent` - are the PRODUCTION tunnel's. A checkout
// with no .env therefore addressed production instead of failing, which is the one failure mode a
// test harness must never have.
//
// validate() is pure: it takes strings (or the absence of them) and returns a verdict. It opens
// no connection and reads no environment, so the negative cases can be driven directly by the
// tests without a database existing at all. resolve_from_env() is the thin adapter that feeds it
// from the .env loader this codebase uses.

#include <stdexcept>
#include <string>

#include "../src/common/env_loader.hpp"

namespace hermes {
namespace testcfg {

struct TestDbConfig {
    bool ok = false;
    std::string problem;      // why it was refused, for the operator
    std::string host;
    std::string user;
    std::string password;
    std::string schema;
    int port = 0;
};

// Pure validator. `opt_in` is the explicit acknowledgement that this is a test run.
inline TestDbConfig validate(const std::string& opt_in,
                            const std::string& host,
                            const std::string& port_str,
                            const std::string& user,
                            const std::string& password,
                            const std::string& schema) {
    TestDbConfig c;

    // 1. Explicit opt-in. Without it, nothing else is even looked at.
    if (opt_in.empty()) {
        c.problem = "CPP_TEST_DB is not set. Database-backed tests are disabled rather than "
                    "defaulted, because the old defaults pointed at the production tunnel.";
        return c;
    }

    // 2. Every value must be present. No fallbacks, no guesses.
    if (host.empty() || port_str.empty() || user.empty() || schema.empty()) {
        c.problem = "CPP_TEST_DB is set, but MYSQL_HOST / MYSQL_PORT / MYSQL_USER / DATABASE_NAME "
                    "are not all present. Refusing to substitute a default.";
        return c;
    }
    c.host = host;
    c.user = user;
    c.schema = schema;
    c.password = password;

    // 3. The port must be a real port, and not the production tunnel's.
    try {
        std::size_t used = 0;
        c.port = std::stoi(port_str, &used);
        if (used != port_str.size()) throw std::invalid_argument("trailing characters");
    } catch (...) {
        c.problem = "MYSQL_PORT is not a number: '" + port_str + "'";
        return c;
    }
    if (c.port <= 0 || c.port > 65535) {
        c.problem = "MYSQL_PORT is out of range: " + port_str;
        return c;
    }
    if (c.port == 3307) {
        c.problem = "MYSQL_PORT 3307 is the production SSH tunnel. Refusing to connect.";
        return c;
    }

    // 4. Nothing that describes production.
    if (schema == "myjob_agent" || schema == "mylife" || schema == "land_record" ||
        schema == "lr_probe" || schema == "cpp_trading_agent") {
        c.problem = "DATABASE_NAME '" + schema + "' is a live database, not a test schema.";
        return c;
    }
    if (user == "mylife" || user == "root" || user == "landuser") {
        c.problem = "MYSQL_USER '" + user + "' is not a restricted test account.";
        return c;
    }
    // A test database reached over the network is one somebody can mistake for a real one.
    if (host != "127.0.0.1" && host != "localhost" && host != "::1") {
        c.problem = "MYSQL_HOST '" + host + "' is not loopback. Refusing to connect.";
        return c;
    }

    // 5. The schema has to be named as a test schema.
    const bool ends_with_test = schema.size() > 5 &&
                                schema.compare(schema.size() - 5, 5, "_test") == 0;
    if (schema != "hermes_cpp_test" && !ends_with_test) {
        c.problem = "DATABASE_NAME '" + schema + "' is not a test schema "
                    "(expected hermes_cpp_test, or any name ending in _test).";
        return c;
    }

    c.ok = true;
    return c;
}

// Adapter: reads the values the way the rest of the codebase does, with NO defaults.
inline TestDbConfig resolve_from_env() {
    return validate(
        EnvLoader::get("CPP_TEST_DB", ""),
        EnvLoader::get("MYSQL_HOST", ""),
        EnvLoader::get("MYSQL_PORT", ""),
        EnvLoader::get("MYSQL_USER", ""),
        EnvLoader::get("MYSQL_PASSWORD", ""),
        EnvLoader::get("DATABASE_NAME", ""));
}

}  // namespace testcfg
}  // namespace hermes
