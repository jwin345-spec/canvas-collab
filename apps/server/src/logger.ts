import { createRequire } from 'node:module';
import { type Logger, pino } from 'pino';
import type { ServerConfig } from './config';

export type { Logger };

/** pino-pretty is a dev dependency; production installs won't have it. */
function prettyPrinterAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export function createLogger(config: Pick<ServerConfig, 'env' | 'logLevel'>): Logger {
  const pretty = config.env === 'development' && prettyPrinterAvailable();
  return pino({
    level: config.logLevel,
    base: { service: 'canvas-collab-server' },
    redact: { paths: ['token', '*.token', 'req.headers.authorization'], censor: '[redacted]' },
    // Human-friendly output locally; newline-delimited JSON everywhere else.
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}
