module.exports = {
  apps: [{
    name: 'monad-trading-bot',
    script: 'src/bot.js',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    max_restarts: 100,
    restart_delay: 5000,
    min_uptime: '10s',
    watch: false,
    max_memory_restart: '500M',
    kill_timeout: 5000,
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
