type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class Logger {
  constructor(private readonly minLevel: Level = 'info') {}

  private log(level: Level, msg: string): void {
    if (ORDER[level] < ORDER[this.minLevel]) return;
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}`;
    (level === 'error' || level === 'warn' ? console.error : console.log)(line);
  }

  debug(msg: string): void { this.log('debug', msg); }
  info(msg: string): void { this.log('info', msg); }
  warn(msg: string): void { this.log('warn', msg); }
  error(msg: string): void { this.log('error', msg); }
}
