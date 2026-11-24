import { createHash } from "node:crypto";
import { Client } from "pg";

export function healthTargetFingerprint(databaseUrl: string): string {
  const resolved = (
    new Client({ connectionString: databaseUrl }) as Client & {
      connectionParameters: {
        host: string;
        port: number;
        database: string;
        user: string;
        options?: string;
      };
    }
  ).connectionParameters;
  const host = resolved.host.startsWith("/")
    ? resolved.host
    : resolved.host.toLowerCase();
  const role =
    resolved.options?.match(/(?:^|\s)(?:-c\s+)?role=([^\s]+)/)?.[1] ?? "";
  return createHash("sha256")
    .update(
      JSON.stringify([
        host,
        resolved.port,
        resolved.database,
        resolved.user,
        role,
      ]),
    )
    .digest("hex");
}
