module.exports = {
  apps: [{
    name: 'my-job-agent',
    script: 'dist/main.js',
    cwd: '/home/swarna-sekhar-dhar/projects/my-job-agent',
    instances: 1,
    exec_mode: 'fork',
    node_args: '--enable-source-maps',
    merge_logs: true,
    out_file: '/home/swarna-sekhar-dhar/.pm2/logs/my-job-agent-out.log',
    error_file: '/home/swarna-sekhar-dhar/.pm2/logs/my-job-agent-err.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    max_restarts: 10,
    min_uptime: '5s',
    kill_timeout: 30000,
    env_file: '.env',
    // DB connection MUST come from .env (MYSQL_HOST/MYSQL_PORT/MYSQL_USER/
    // MYSQL_PASSWORD): .env points at the live engine database
    // (10.0.0.99:3306 via the 127.0.0.1:3307 tunnel) — the same DB the
    // trading engine writes trades, positions and FYERS ticks into. Hard-coding
    // MYSQL_* here (commit ddee199) shadowed .env (pm2 `env` beats `env_file`),
    // silently pointed the web app at the desktop's stale local MySQL and made
    // /fnf-trading render an empty ledger while the engine traded elsewhere.
    // One data plane = one database. Do not re-add MYSQL_* to this block.
    env: {
      NODE_ENV: 'production',
      AWS_REGION: 'us-east-1',
      HERMES_BEDROCK_MODEL_ID: 'qwen.qwen3-coder-next',
      DATABASE_NAME: 'myjob_agent',
    },
  }],
};
