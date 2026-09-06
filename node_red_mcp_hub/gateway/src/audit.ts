import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type AuditEntry = {
  server_id: string;
  tool: string;
  outcome: "ok" | "error";
  flow_id?: string;
  backup_file?: string;
  detail?: string;
};

/** Append-only JSONL write log; a logging failure must never fail or block the write it describes. */
export class AuditLog {
  constructor(private readonly path: string) {}

  async record(entry: AuditEntry): Promise<void> {
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`;
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await appendFile(this.path, line, { mode: 0o600 });
    } catch { /* best-effort only */ }
  }
}
