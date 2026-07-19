type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function redactSensitive(input: string): string {
  return input
    .replace(
      /\b(?:postgres|postgresql):\/\/[^\s"'`]+/gi,
      'postgres://REDACTED',
    )
    .replace(/\b(?:sk_live|agent|anon|claim)_[A-Za-z0-9_-]+/g, (token) => {
      const [prefix] = token.split('_');
      return `${prefix}_REDACTED`;
    })
    .replace(/\bkey=[A-Za-z0-9_-]+/g, 'key=REDACTED')
    .replace(
      /\b(password|apiKey|agentToken|anonToken)=\S+/gi,
      '$1=REDACTED',
    );
}

export class Logger {
  constructor(private readonly minLevel: Level = 'info') {}

  private log(level: Level, msg: string): void {
    if (ORDER[level] < ORDER[this.minLevel]) return;
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${redactSensitive(msg)}`;
    (level === 'error' || level === 'warn' ? console.error : console.log)(line);
  }

  debug(msg: string): void { this.log('debug', msg); }
  info(msg: string): void { this.log('info', msg); }
  warn(msg: string): void { this.log('warn', msg); }
  error(msg: string): void { this.log('error', msg); }
}
