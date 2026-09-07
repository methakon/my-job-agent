#!/bin/bash
# Reset local MySQL database
mysql -h 127.0.0.1 -P 3306 -u root -pwbsd99 << 'EOF'
DROP DATABASE IF EXISTS myjob_agent;
CREATE DATABASE myjob_agent CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
EOF
