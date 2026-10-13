// PM2 process definition for the C++ trading engine.
//
// Why this file exists: the settings the live process actually runs with
// (instances: 1, exec_mode: fork) previously survived ONLY in pm2's dump.pm2.
// Nothing on disk pinned them, so a rebuild or a `pm2 resurrect` could have
// restarted the engine in cluster mode or as several instances. The engine
// enforces a single-instance file lock and exits fatally on a second instance,
// so that would have produced no trading engine at all rather than a degraded
// one -- a silent, self-inflicted outage.
//
// READ THIS FIRST: the sibling `ecosystem.config.js` in this same tree describes
// `my-job-agent` (Node, `dist/main.js`), NOT this engine. Do not point pm2 at it
// expecting the trading engine.
//
// Deliberately absent: any MYSQL_* / database key. The engine loads `.env` itself
// at startup (EnvLoader::load) and pm2's `env` block takes precedence over
// `env_file`. A shadowed MYSQL_* has already caused a silent split-brain once in
// this project -- the web app read a stale local database while the engine traded
// against production. Keep this block free of database keys.

module.exports = {
  apps: [{
    name: 'cpp-trading-agent',
    script: '/home/ubuntu/cpp-trading-agent/bin/cpp-trading-agent',
    cwd: '/home/ubuntu/cpp-trading-agent',
    instances: 1,
    exec_mode: 'fork',
    merge_logs: true,
    out_file: '/home/ubuntu/.pm2/logs/cpp-trading-agent-out.log',
    error_file: '/home/ubuntu/.pm2/logs/cpp-trading-agent-error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    max_restarts: 10,
    min_uptime: '5s',
    kill_timeout: 30000,
  }],
};
