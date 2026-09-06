import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TargetConfig } from "./config.js";
import type { NodeRedClient } from "./node-red.js";

export class BackupError extends Error {}

export class BackupManager {
  constructor(private readonly directory: string, private readonly retain: number, private readonly maxAgeDays = 0) {}

  async capture(target: TargetConfig, client: NodeRedClient, tool: string): Promise<void> {
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
      await Promise.all(stale.map(async (item) => {
        try { await unlink(join(targetDir, item)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }));
    } catch (error) {
      try { await unlink(temporaryPath); } catch {}
      const detail = error instanceof Error ? error.message : "unknown error";
      throw new BackupError(`Could not create pre-write backup: ${detail}`);
    }
  }
}

