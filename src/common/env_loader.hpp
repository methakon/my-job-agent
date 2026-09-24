#ifndef ENV_LOADER_HPP
#define ENV_LOADER_HPP

#include <string>
#include <unordered_map>

class EnvLoader {
public:
    static bool load(const std::string& env_path = ".env");
    static std::string get(const std::string& key, const std::string& fallback = "");
    static int get_int(const std::string& key, int fallback = 0);

private:
    static std::unordered_map<std::string, std::string> env_vars_;
};

#endif // ENV_LOADER_HPP
