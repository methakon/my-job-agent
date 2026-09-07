#!/bin/bash

#FYERS_AUTH_CODE=<auth_code_from_redirect_url>

echo "Testing FYERS token exchange..."
echo "Auth code: ${FYERS_AUTH_CODE:0:20}..."

if [ -z "$FYERS_AUTH_CODE" ]; then
    echo "Please set FYERS_AUTH_CODE environment variable with the auth code from the redirect URL"
    exit 1
fi

curl -s "http://localhost:3010/trading/fyers/exchange-token?code=$FYERS_AUTH_CODE" | jq .
