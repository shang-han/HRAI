import winston from 'winston'
import path from 'path'
import { app } from 'electron'
import fs from 'fs'

export class LogManager {
  private logger: winston.Logger
  private logDir: string

  constructor() {
    this.logDir = path.join(app.getPath('userData'), 'log')
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true })
    }

    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => {
          return `[${timestamp}] [${level.toUpperCase()}] ${message}`
        })
      ),
      transports: [
        new winston.transports.File({
          filename: path.join(this.logDir, 'error.log'),
          level: 'error',
          maxsize: 5 * 1024 * 1024, // 5MB
          maxFiles: 5
        }),
        new winston.transports.File({
          filename: path.join(this.logDir, 'combined.log'),
          maxsize: 5 * 1024 * 1024,
          maxFiles: 10
        }),
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        })
      ]
    })
  }

  info(message: string): void {
    this.logger.info(message)
  }

  warn(message: string): void {
    this.logger.warn(message)
  }

  error(message: string, err?: any): void {
    this.logger.error(err ? `${message}: ${err.message || err}` : message)
  }

  debug(message: string): void {
    this.logger.debug(message)
  }

  getLevel(): string {
    return this.logger.level
  }

  setLevel(level: string): void {
    this.logger.level = level
  }
}
