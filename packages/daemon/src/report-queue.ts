import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { LamaSyncApiClient, OperationReport } from "@lamasync/core";

export interface ReportQueue {
  enqueue(report: OperationReport): void;
  flush(): Promise<number>;
}

const QUEUE_FILENAME = "reports-queue.jsonl";
const MAX_ENTRIES = 1_000;

function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return join(process.env.HOME ?? "/tmp", path.slice(2));
  }
  if (path === "~") {
    return process.env.HOME ?? "/tmp";
  }
  return path;
}

export function createReportQueue(
  dataDir: string,
  client: LamaSyncApiClient,
): ReportQueue {
  const dir = expandPath(dataDir);
  const queuePath = join(dir, QUEUE_FILENAME);

  const ensureDir = (): void => {
    mkdirSync(dir, { recursive: true });
  };

  const readLines = (): string[] => {
    try {
      const text = readFileSync(queuePath, "utf8");
      return text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
  };

  const writeLines = (lines: string[]): void => {
    ensureDir();
    const tmp = `${queuePath}.tmp`;
    writeFileSync(tmp, lines.length ? `${lines.join("\n")}\n` : "", { mode: 0o600 });
    renameSync(tmp, queuePath);
  };

  const trim = (): void => {
    const lines = readLines();
    if (lines.length > MAX_ENTRIES) {
      writeLines(lines.slice(lines.length - MAX_ENTRIES));
    }
  };

  return {
    enqueue(report) {
      try {
        ensureDir();
        const line = JSON.stringify(report);
        writeFileSync(queuePath, `${line}\n`, { flag: "a", mode: 0o600 });
        trim();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[report-queue] failed to enqueue report: ${msg}`);
      }
    },

    async flush(): Promise<number> {
      const lines = readLines();
      if (lines.length === 0) return 0;

      let sent = 0;
      let failed = false;
      const remaining: string[] = [];
      for (const line of lines) {
        if (failed) {
          remaining.push(line);
          continue;
        }
        let report: OperationReport | undefined;
        try {
          report = JSON.parse(line) as OperationReport;
        } catch {
          // Drop unparseable lines rather than retrying forever.
          sent += 1;
          continue;
        }
        try {
          await client.reportOperation(report);
          sent += 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[report-queue] failed to flush report: ${msg}`);
          failed = true;
          remaining.push(line);
        }
      }

      writeLines(remaining);
      return sent;
    },
  };
}
