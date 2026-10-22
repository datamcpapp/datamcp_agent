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
  const collector = createAgentRowCollector<T>(maxRows);
  for (const row of rows) collector.add(row);
  return collector.finish();
}

export function createAgentRowCollector<T>(maxRows: number) {
  const result: T[] = [];
  let bytes = 2;
  let truncated = false;
  let oversized = false;

  return {
    add(row: T) {
      if (truncated || oversized) return;
      if (result.length >= maxRows) {
        truncated = true;
        return;
      }
      const serialized = JSON.stringify(row);
      if (serialized === undefined) {
        oversized = true;
        return;
      }
      const rowBytes =
        Buffer.byteLength(serialized, 'utf8') + (result.length ? 1 : 0);
      if (bytes + rowBytes > MAX_BYTES) {
        if (!result.length) oversized = true;
        else truncated = true;
        return;
      }
      result.push(row);
      bytes += rowBytes;
    },
    finish() {
      if (oversized) {
        throw new Error('A query result row exceeds the response size limit');
      }
      return { rows: result, truncated };
    },
  };
}
