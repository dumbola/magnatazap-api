// logger.js
const pino = require('pino');

const level = process.env.LOG_LEVEL || 'info';
const isProd = process.env.NODE_ENV === 'production';

const logger = pino({
  level,
  base: null, // não polui com pid/hostname
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) { return { level: label }; }
  },
  transport: !isProd ? { target: 'pino-pretty', options: { translateTime: true } } : undefined
});

module.exports = logger;
