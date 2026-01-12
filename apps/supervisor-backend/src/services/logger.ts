/**
 * Structured Logger Service
 * Provides consistent logging with structured data and log levels
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  runId?: string;
  taskId?: string;
  workerId?: string;
  [key: string]: unknown;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
}

// Log level priority (lower = more verbose)
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private minLevel: LogLevel;
  private handlers: Array<(entry: LogEntry) => void> = [];

  constructor() {
    this.minLevel = (process.env['LOG_LEVEL'] as LogLevel) ?? 'info';
  }

  /**
   * Set minimum log level
   */
  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  /**
   * Add a log handler for custom processing
   */
  addHandler(handler: (entry: LogEntry) => void): void {
    this.handlers.push(handler);
  }

  /**
   * Remove a log handler
   */
  removeHandler(handler: (entry: LogEntry) => void): void {
    const index = this.handlers.indexOf(handler);
    if (index > -1) {
      this.handlers.splice(index, 1);
    }
  }

  /**
   * Core logging method
   */
  private log(level: LogLevel, message: string, context?: LogContext): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.minLevel]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context,
    };

    // Call handlers
    for (const handler of this.handlers) {
      try {
        handler(entry);
      } catch {
        // Ignore handler errors
      }
    }

    // Format output
    const prefix = this.formatPrefix(entry);
    const contextStr = context ? ` ${JSON.stringify(context)}` : '';

    switch (level) {
      case 'debug':
        console.debug(`${prefix} ${message}${contextStr}`);
        break;
      case 'info':
        console.info(`${prefix} ${message}${contextStr}`);
        break;
      case 'warn':
        console.warn(`${prefix} ${message}${contextStr}`);
        break;
      case 'error':
        console.error(`${prefix} ${message}${contextStr}`);
        break;
    }
  }

  private formatPrefix(entry: LogEntry): string {
    const time = entry.timestamp.slice(11, 23); // HH:mm:ss.sss
    const levelStr = entry.level.toUpperCase().padEnd(5);
    return `[${time}] [${levelStr}]`;
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.log('error', message, context);
  }

  /**
   * Create a child logger with preset context
   */
  child(defaultContext: LogContext): ChildLogger {
    return new ChildLogger(this, defaultContext);
  }
}

class ChildLogger {
  constructor(
    private parent: Logger,
    private defaultContext: LogContext
  ) {}

  private mergeContext(context?: LogContext): LogContext {
    return { ...this.defaultContext, ...context };
  }

  debug(message: string, context?: LogContext): void {
    this.parent.debug(message, this.mergeContext(context));
  }

  info(message: string, context?: LogContext): void {
    this.parent.info(message, this.mergeContext(context));
  }

  warn(message: string, context?: LogContext): void {
    this.parent.warn(message, this.mergeContext(context));
  }

  error(message: string, context?: LogContext): void {
    this.parent.error(message, this.mergeContext(context));
  }
}

// Singleton instance
export const logger = new Logger();

// Export class for testing
export { Logger, ChildLogger };
