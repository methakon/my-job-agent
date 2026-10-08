#ifndef COMMON_CRYPTO_UTIL_HPP
#define COMMON_CRYPTO_UTIL_HPP

#include <string>
#include <vector>
#include <sstream>
#include <iomanip>
#include <cstring>
#include <cstdint>
#include <stdexcept>
#include <openssl/rand.h>
#include <openssl/evp.h>

namespace crypto_util {

// -------------------------------------------------------------------------
// SHA-256 Implementation
// -------------------------------------------------------------------------
class Sha256 {
public:
    static std::vector<uint8_t> hash(const std::string& input) {
        return hash(reinterpret_cast<const uint8_t*>(input.data()), input.size());
    }

    static std::vector<uint8_t> hash(const uint8_t* data, size_t len) {
        uint32_t h[8] = {
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
        };

        static const uint32_t k[64] = {
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        };

        std::vector<uint8_t> msg(data, data + len);
        uint64_t bit_len = static_cast<uint64_t>(len) * 8;
        msg.push_back(0x80);
        while ((msg.size() % 64) != 56) {
            msg.push_back(0x00);
        }
        for (int i = 7; i >= 0; --i) {
            msg.push_back(static_cast<uint8_t>((bit_len >> (i * 8)) & 0xff));
        }

        for (size_t chunk = 0; chunk < msg.size(); chunk += 64) {
            uint32_t w[64];
            for (size_t i = 0; i < 16; ++i) {
                w[i] = (static_cast<uint32_t>(msg[chunk + i * 4]) << 24) |
                       (static_cast<uint32_t>(msg[chunk + i * 4 + 1]) << 16) |
                       (static_cast<uint32_t>(msg[chunk + i * 4 + 2]) << 8) |
                       (static_cast<uint32_t>(msg[chunk + i * 4 + 3]));
            }
            for (size_t i = 16; i < 64; ++i) {
                auto rotr = [](uint32_t x, uint32_t n) { return (x >> n) | (x << (32 - n)); };
                uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
                uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
                w[i] = w[i - 16] + s0 + w[i - 7] + s1;
            }

            uint32_t a = h[0], b = h[1], c = h[2], d = h[3];
            uint32_t e = h[4], f = h[5], g = h[6], h_val = h[7];

            auto rotr = [](uint32_t x, uint32_t n) { return (x >> n) | (x << (32 - n)); };
            for (size_t i = 0; i < 64; ++i) {
                uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
                uint32_t ch = (e & f) ^ ((~e) & g);
                uint32_t temp1 = h_val + S1 + ch + k[i] + w[i];
                uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
                uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
                uint32_t temp2 = S0 + maj;

                h_val = g;
                g = f;
                f = e;
                e = d + temp1;
                d = c;
                c = b;
                b = a;
                a = temp1 + temp2;
            }

            h[0] += a; h[1] += b; h[2] += c; h[3] += d;
            h[4] += e; h[5] += f; h[6] += g; h[7] += h_val;
        }

        std::vector<uint8_t> digest(32);
        for (size_t i = 0; i < 8; ++i) {
            digest[i * 4] = static_cast<uint8_t>((h[i] >> 24) & 0xff);
            digest[i * 4 + 1] = static_cast<uint8_t>((h[i] >> 16) & 0xff);
            digest[i * 4 + 2] = static_cast<uint8_t>((h[i] >> 8) & 0xff);
            digest[i * 4 + 3] = static_cast<uint8_t>(h[i] & 0xff);
        }
        return digest;
    }
};

// -------------------------------------------------------------------------
// Hex Helpers
// -------------------------------------------------------------------------
inline std::vector<uint8_t> hex_to_bytes(const std::string& hex) {
    std::vector<uint8_t> bytes;
    for (size_t i = 0; i + 1 < hex.size(); i += 2) {
        uint8_t byte = static_cast<uint8_t>(std::stoul(hex.substr(i, 2), nullptr, 16));
        bytes.push_back(byte);
    }
    return bytes;
}

inline std::string bytes_to_hex(const uint8_t* data, size_t len) {
    std::string s;
    s.reserve(len * 2);
    static const char hex_chars[] = "0123456789abcdef";
    for (size_t i = 0; i < len; ++i) {
        s.push_back(hex_chars[(data[i] >> 4) & 0x0F]);
        s.push_back(hex_chars[data[i] & 0x0F]);
    }
    return s;
}

// -------------------------------------------------------------------------
// AES-256-CBC Decryption
// -------------------------------------------------------------------------
class Aes256Cbc {
private:
    static const uint8_t sbox[256];
    static const uint8_t rsbox[256];
    static const uint32_t rcon[15];

    static uint8_t gmul(uint8_t a, uint8_t b) {
        uint8_t p = 0;
        for (int counter = 0; counter < 8; counter++) {
            if ((b & 1) != 0) p ^= a;
            bool hi_bit_set = (a & 0x80) != 0;
            a <<= 1;
            if (hi_bit_set) a ^= 0x1b;
            b >>= 1;
        }
        return p;
    }

    static void key_expansion(const uint8_t* key, uint8_t* round_keys) {
        std::memcpy(round_keys, key, 32);
        size_t bytes_generated = 32;
        size_t rcon_iteration = 1;
        uint8_t temp[4];

        while (bytes_generated < 240) {
            for (int i = 0; i < 4; i++) temp[i] = round_keys[bytes_generated - 4 + i];
            if (bytes_generated % 32 == 0) {
                // RotWord & SubWord & Rcon
                uint8_t t = temp[0];
                temp[0] = sbox[temp[1]] ^ static_cast<uint8_t>(rcon[rcon_iteration++]);
                temp[1] = sbox[temp[2]];
                temp[2] = sbox[temp[3]];
                temp[3] = sbox[t];
            } else if (bytes_generated % 32 == 16) {
                // SubWord
                for (int i = 0; i < 4; i++) temp[i] = sbox[temp[i]];
            }
            for (int i = 0; i < 4; i++) {
                round_keys[bytes_generated] = round_keys[bytes_generated - 32] ^ temp[i];
                bytes_generated++;
            }
        }
    }

    static void inv_sub_bytes(uint8_t* state) {
        for (int i = 0; i < 16; i++) state[i] = rsbox[state[i]];
    }

    static void inv_shift_rows(uint8_t* state) {
        uint8_t temp[16];
        std::memcpy(temp, state, 16);
        state[1] = temp[13]; state[5] = temp[1]; state[9] = temp[5]; state[13] = temp[9];
        state[2] = temp[10]; state[6] = temp[14]; state[10] = temp[2]; state[14] = temp[6];
        state[3] = temp[7]; state[7] = temp[11]; state[11] = temp[15]; state[15] = temp[3];
    }

    static void inv_mix_columns(uint8_t* state) {
        for (int i = 0; i < 4; i++) {
            uint8_t a = state[i * 4];
            uint8_t b = state[i * 4 + 1];
            uint8_t c = state[i * 4 + 2];
            uint8_t d = state[i * 4 + 3];

            state[i * 4] = gmul(a, 0x0e) ^ gmul(b, 0x0b) ^ gmul(c, 0x0d) ^ gmul(d, 0x09);
            state[i * 4 + 1] = gmul(a, 0x09) ^ gmul(b, 0x0e) ^ gmul(c, 0x0b) ^ gmul(d, 0x0d);
            state[i * 4 + 2] = gmul(a, 0x0d) ^ gmul(b, 0x09) ^ gmul(c, 0x0e) ^ gmul(d, 0x0b);
            state[i * 4 + 3] = gmul(a, 0x0b) ^ gmul(b, 0x0d) ^ gmul(c, 0x09) ^ gmul(d, 0x0e);
        }
    }

    static void add_round_key(uint8_t* state, const uint8_t* round_key) {
        for (int i = 0; i < 16; i++) state[i] ^= round_key[i];
    }

    static void decrypt_block(const uint8_t* in, uint8_t* out, const uint8_t* round_keys) {
        uint8_t state[16];
        std::memcpy(state, in, 16);

        add_round_key(state, round_keys + 224); // Round 14

        for (int round = 13; round > 0; round--) {
            inv_shift_rows(state);
            inv_sub_bytes(state);
            add_round_key(state, round_keys + round * 16);
            inv_mix_columns(state);
        }

        inv_shift_rows(state);
        inv_sub_bytes(state);
        add_round_key(state, round_keys); // Round 0

        std::memcpy(out, state, 16);
    }

public:
    static std::string decrypt(const std::vector<uint8_t>& ciphertext,
                               const std::vector<uint8_t>& key,
                               const std::vector<uint8_t>& iv) {
        if (ciphertext.empty() || ciphertext.size() % 16 != 0 || key.size() != 32 || iv.size() != 16) {
            return "";
        }

        uint8_t round_keys[240];
        key_expansion(key.data(), round_keys);

        std::vector<uint8_t> plaintext(ciphertext.size());
        std::vector<uint8_t> prev_block = iv;

        for (size_t offset = 0; offset < ciphertext.size(); offset += 16) {
            uint8_t decrypted_block[16];
            decrypt_block(ciphertext.data() + offset, decrypted_block, round_keys);
            for (int i = 0; i < 16; i++) {
                plaintext[offset + i] = decrypted_block[i] ^ prev_block[i];
            }
            std::memcpy(prev_block.data(), ciphertext.data() + offset, 16);
        }

        // Remove PKCS#7 padding
        if (plaintext.empty()) return "";
        uint8_t pad_val = plaintext.back();
        if (pad_val == 0 || pad_val > 16 || pad_val > plaintext.size()) return "";
        for (size_t i = plaintext.size() - pad_val; i < plaintext.size(); ++i) {
            if (plaintext[i] != pad_val) return "";
        }
        plaintext.resize(plaintext.size() - pad_val);

        return std::string(reinterpret_cast<const char*>(plaintext.data()), plaintext.size());
    }
};

// -------------------------------------------------------------------------
// Decrypt token helper: if colon present, decrypts with SHA256(secret)
// -------------------------------------------------------------------------
inline std::string decrypt_token_if_needed(const std::string& token_str, const std::string& secret) {
    if (token_str.empty()) return "";
    auto colon_pos = token_str.find(':');
    if (colon_pos == std::string::npos) {
        return token_str; // already plaintext
    }
    std::string iv_hex = token_str.substr(0, colon_pos);
    std::string cipher_hex = token_str.substr(colon_pos + 1);

    auto iv = hex_to_bytes(iv_hex);
    auto ciphertext = hex_to_bytes(cipher_hex);
    auto key = Sha256::hash(secret);

    return Aes256Cbc::decrypt(ciphertext, key, iv);
}

// -------------------------------------------------------------------------
// Encrypt token helper: AES-256-CBC, output ivHex:cipherHex
// -------------------------------------------------------------------------
inline std::string encrypt_token(const std::string& plaintext, const std::string& secret) {
    if (plaintext.empty() || secret.empty()) return plaintext;
    auto key = Sha256::hash(secret);
    uint8_t iv[16];
    if (RAND_bytes(iv, 16) <= 0) {
        for (int i = 0; i < 16; i++) iv[i] = static_cast<uint8_t>(rand() % 256);
    }
    EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
    if (!ctx) return "";
    EVP_EncryptInit_ex(ctx, EVP_aes_256_cbc(), nullptr, key.data(), iv);
    std::vector<uint8_t> ciphertext(plaintext.size() + 32);
    int len1 = 0, len2 = 0;
    EVP_EncryptUpdate(ctx, ciphertext.data(), &len1, reinterpret_cast<const uint8_t*>(plaintext.data()), static_cast<int>(plaintext.size()));
    EVP_EncryptFinal_ex(ctx, ciphertext.data() + len1, &len2);
    EVP_CIPHER_CTX_free(ctx);
    ciphertext.resize(len1 + len2);
    return bytes_to_hex(iv, 16) + ":" + bytes_to_hex(ciphertext.data(), ciphertext.size());
}

} // namespace crypto_util

#endif // COMMON_CRYPTO_UTIL_HPP
