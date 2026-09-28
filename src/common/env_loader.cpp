#include "env_loader.hpp"
#include <fstream>
#include <sstream>
#include <iostream>
#include <algorithm>

std::unordered_map<std::string, std::string> EnvLoader::env_vars_;

static inline std::string trim(const std::string& s) {
    auto start = s.find_first_not_of(" \t\r\n\"'");
    if (start == std::string::npos) return "";
    auto end = s.find_last_not_of(" \t\r\n\"'");
    return s.substr(start, end - start + 1);
}

bool EnvLoader::load(const std::string& env_path) {
    std::ifstream file(env_path);
    if (!file.is_open()) {
        // Fallback search in parent directory
        std::ifstream parent_file("../.env");
        if (!parent_file.is_open()) {
            std::cerr << "[EnvLoader] Warning: Could not open .env or ../.env file\n";
            return false;
        }
        return load("../.env");
    }

    std::string line;
    while (std::getline(file, line)) {
        line = trim(line);
        if (line.empty() || line[0] == '#') continue;

        auto pos = line.find('=');
        if (pos != std::string::npos) {
            std::string key = trim(line.substr(0, pos));
            std::string val = trim(line.substr(pos + 1));
            if (!key.empty()) {
                env_vars_[key] = val;
            }
        }
    }
    std::cout << "[EnvLoader] Loaded " << env_vars_.size() << " environment variables from " << env_path << "\n";
    return true;
}

std::string EnvLoader::get(const std::string& key, const std::string& fallback) {
    auto it = env_vars_.find(key);
    if (it != env_vars_.end() && !it->second.empty()) {
        return it->second;
    }
    const char* env_val = std::getenv(key.c_str());
    if (env_val && std::string(env_val).length() > 0) {
        return std::string(env_val);
    }
    return fallback;
}

int EnvLoader::get_int(const std::string& key, int fallback) {
    std::string val = get(key, "");
    if (val.empty()) return fallback;
    try {
        return std::stoi(val);
    } catch (...) {
        return fallback;
    }
}

double EnvLoader::get_double(const std::string& key, double fallback) {
    std::string val = get(key, "");
    if (val.empty()) return fallback;
    try {
        return std::stod(val);
    } catch (...) {
        return fallback;
    }
}

