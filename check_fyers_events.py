import re
import sys

with open('/home/swarna-sekhar-dhar/projects/my-job-agent/node_modules/fyers-api-v3/HSM/datasocket.min.js', 'r') as f:
    min_content = f.read()

matches = re.findall(r'\.on\(\s*[\'"]([^\'"]+)[\'"]\s*,', min_content)
print("Event types found in SDK:", set(matches))
