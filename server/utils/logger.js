const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

const logDir = path.join(__dirname, '../../logs');

// Configurar niveles de log
const levels = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4,
};

// Determinar nivel basado en entorno
const level = () => {
    const env = process.env.NODE_ENV || 'development';
    const isDevelopment = env === 'development';
    return isDevelopment ? 'debug' : 'info';
};

// Definir colores para cada nivel
const colors = {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    http: 'magenta',
    debug: 'blue',
};

winston.addColors(colors);

// Formato de los logs
const format = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.colorize({ all: true }),
    winston.format.printf(
        (info) => `${info.timestamp} ${info.level}: ${info.message}`
    )
);

// Transportes
const transports = [
    // Consola
    new winston.transports.Console({
        format: winston.format.combine(
            winston.format.colorize(),
            format
        ),
    }),

    // Archivo de errores
    new DailyRotateFile({
        filename: path.join(logDir, 'error-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        level: 'error',
        maxFiles: '30d',
        maxSize: '20m',
        format: winston.format.combine(
            winston.format.uncolorize(),
            winston.format.timestamp(),
            winston.format.json()
        ),
    }),

    // Archivo combinado
    new DailyRotateFile({
        filename: path.join(logDir, 'combined-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxFiles: '14d',
        maxSize: '20m',
        format: winston.format.combine(
            winston.format.uncolorize(),
            winston.format.timestamp(),
            winston.format.json()
        ),
    }),
];

// Crear logger
const logger = winston.createLogger({
    level: level(),
    levels,
    format,
    transports,
    exitOnError: false,
});

// Método auxiliar para loguear requests HTTP
logger.logRequest = (req, res, time) => {
    logger.http(
        `${req.method} ${req.url} ${res.statusCode} - ${time}ms - ${req.ip}`
    );
};

module.exports = logger;
