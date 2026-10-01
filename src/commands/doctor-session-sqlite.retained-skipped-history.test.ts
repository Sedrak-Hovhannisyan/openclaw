import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { isSessionSqliteMigrationWarning } from "../infra/session-sqlite-migration-issues.js";
import * as migrationRun from "../infra/session-sqlite-migration-manifest.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { seedDeferredPluginSessionSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

afterEach(() => vi.restoreAllMocks());

function writeTranscript(file: string, sessionId: string): Buffer {
  fs.writeFileSync(
    file,
    [
      { type: "session", version: 3, id: sessionId },
      {
        type: "message",
        id: `${sessionId}-message`,
        parentId: null,
        message: { role: "user", content: "added after the receipt" },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  return fs.readFileSync(file);
}

describe("history outside a completed deferred plugin import receipt (#162525)", () => {
  it.each([false, true])(
    "names each skipped transcript instead of reporting a clean import (obligations cleared: %s)",
    async (obligationsCleared) => {
      await withOpenClawTestState({ label: "retained-skipped-history" }, async (state) => {
        const { cfg, storePath } = await seedDeferredPluginSessionSource(state, "default");
        const run = () =>
          runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
        expect((await run()).totals.importedEntries).toBe(2);
        if (obligationsCleared) {
          await recordDeferredPluginMigrations({
            env: state.env,
            pending: [],
            resolvedPluginIds: ["fixture-plugin"],
          });
        }
        const fresh = path.join(path.dirname(storePath), "fresh-session.jsonl");
        const bytes = writeTranscript(fresh, "fresh-session");

        const report = await run();

        expect(report.totals.importedEntries).toBe(0);
        const issues = report.targets.flatMap((target) => target.issues);
        expect(issues.every(isSessionSqliteMigrationWarning)).toBe(true);
        const skipped = issues.filter(
          (issue) => issue.code === "retained_import_transcript_skipped",
        );
        expect(skipped).toHaveLength(1);
        expect(skipped[0]?.message).toContain(fresh);
        // Diagnostics only: the transcript is preserved, never imported or discarded.
        const archived = migrationRun
          .listSessionSqliteMigrationManifestPaths(state.env)
          .flatMap((file) => migrationRun.readSessionSqliteMigrationManifest(file)?.targets ?? [])
          .flatMap((target) => target.plannedMoves)
          .find((move) => move.sourcePath === fresh);
        const preserved = fs.existsSync(fresh) ? fresh : archived?.archivePath;
        expect(preserved && fs.readFileSync(preserved)).toEqual(bytes);
        if (archived) {
          expect(archived.artifact?.classification).toBe("protected");
        }
      });
    },
  );
});
