const MAX_ROWS = 10_000;
const MAX_BYTES = 512 * 1024;

export function resolveMaxRows(requested: number | undefined): number {
  return Number.isInteger(requested) && requested! > 0
    ? Math.min(requested!, MAX_ROWS)
    : 100;
}

export function boundReadQuery(sql: string, maxRows: number): string {
  const statement = sql
    .trim()
    .replace(/;(?=(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*$)/, '');
  if (!/^(?:select|with|values)\b/i.test(statement)) {
    throw new Error(
      'Read-only tunnel queries must be SELECT, WITH, or VALUES statements',
    );
  }
  return `SELECT * FROM (\n${statement}\n) AS datamcp_result LIMIT ${maxRows + 1}`;
}

export function capAgentRows<T>(
  rows: T[],
  maxRows: number,
): {
  rows: T[];
  truncated: boolean;
} {
  const result: T[] = [];
  let bytes = 2;

  for (const row of rows) {
    if (result.length >= maxRows) return { rows: result, truncated: true };

    const serialized = JSON.stringify(row);
    if (serialized === undefined) {
      throw new Error('Query result contains an unserializable row');
    }
    const rowBytes =
      Buffer.byteLength(serialized, 'utf8') + (result.length ? 1 : 0);
    if (bytes + rowBytes > MAX_BYTES) {
      if (!result.length) {
        throw new Error('A query result row exceeds the response size limit');
      }
      return { rows: result, truncated: true };
    }

    result.push(row);
    bytes += rowBytes;
  }

  return { rows: result, truncated: false };
}
