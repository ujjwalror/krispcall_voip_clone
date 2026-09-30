module.exports = {
  apps: [
    {
      name: 'telecom-voice-extension',
      script: 'npm',
      args: 'run worker:telecom-voice-extension',
      cwd: './',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '5s',
      kill_timeout: 10000, // 10s graceful SIGTERM window
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'telecom-reconciliation',
      script: 'npm',
      args: 'run worker:telecom-reconciliation',
      cwd: './',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '5s',
      kill_timeout: 10000, // 10s graceful SIGTERM window
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'telecom-termination',
      script: 'npm',
      args: 'run worker:telecom-termination',
      cwd: './',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '5s',
      kill_timeout: 10000, // 10s graceful SIGTERM window
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
