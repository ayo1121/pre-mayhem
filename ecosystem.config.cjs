module.exports = {
    apps: [
        {
            name: "pre-mayhem",
            script: "dist/index.js",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "300M",
            env: {
                NODE_ENV: "production"
            },
            out_file: "logs/out.log",
            error_file: "logs/error.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss",
            merge_logs: true,
            time: true
        }
    ]
};
