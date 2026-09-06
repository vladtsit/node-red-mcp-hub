import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TargetConfig } from "./config.js";
import type { NodeRedClient } from "./node-red.js";

export class BackupError extends Error {}

export class BackupManager {
  constructor(
    private readonly directory: string,
    private readonly retain: number,
    private readonly maxAgeDays = 0,
    private readonly maxSizeMb = 0,
  ) {}

  /** Returns the created backup's filename, for audit logging and troubleshooting. */
  async capture(target: TargetConfig, client: NodeRedClient, tool: string): Promise<string> {
    const targetDir = join(this.directory, target.id);
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const name = `${stamp}-${tool}-${randomUUID()}.json`;
    const finalPath = join(targetDir, name);
    const temporaryPath = join(targetDir, `.${name}.${randomUUID()}.tmp`);
    try {
      const flows = await client.getFlowsForBackup();
      await mkdir(targetDir, { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, JSON.stringify({ created_at: new Date().toISOString(), server_id: target.id, tool, flows }), { mode: 0o600, flag: "wx" });
      await rename(temporaryPath, finalPath);
      const files = (await readdir(targetDir)).filter((item) => item.endsWith(".json")).sort().reverse();
      const stale = files.slice(this.retain);
      if (this.maxAgeDays > 0) {
        const cutoff = Date.now() - this.maxAgeDays * 24 * 60 * 60 * 1000;
        for (const item of files.slice(0, this.retain)) {
          try { if ((await stat(join(targetDir, item))).mtimeMs < cutoff) stale.push(item); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      }
      if (this.maxSizeMb > 0) {
        const budget = this.maxSizeMb * 1024 * 1024;
        const survivors = files.filter((item) => !stale.includes(item));
        let total = 0;
        for (const item of survivors) {
          try { total += (await stat(join(targetDir, item))).size; }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            continue;
          }
          // Never delete the backup just written, even if it alone exceeds the budget.
          if (total > budget && item !== name) stale.push(item);
        }
      }
      await Promise.all(stale.map(async (item) => {
        try { await unlink(join(targetDir, item)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }));
      return name;
    } catch (error) {
      try { await unlink(temporaryPath); } catch {}
      const detail = error instanceof Error ? error.message : "unknown error";
      throw new BackupError(`Could not create pre-write backup: ${detail}`);
    }
  }

  /** Read-only listing of retained backups for a server, newest first. */
  async list(target: TargetConfig): Promise<{ name: string; tool?: string; created_at?: string; size_bytes: number }[]> {
    const targetDir = join(this.directory, target.id);
    let entries: string[];
    try { entries = await readdir(targetDir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const files = entries.filter((item) => item.endsWith(".json")).sort().reverse();
    return Promise.all(files.map(async (name) => {
      const info = await stat(join(targetDir, name));
      const match = name.match(/^(.*)-([a-z_]+)-[0-9a-f-]{36}\.json$/);
      return { name, tool: match?.[2], created_at: match?.[1], size_bytes: info.size };
    }));
  }
}

