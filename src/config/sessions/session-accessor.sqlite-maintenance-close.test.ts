import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { flushLogger, setLoggerOverride } from "../../logging/logger.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as databaseResources from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import * as databaseExecution from "../../state/openclaw-agent-execution.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import * as maintenanceKick from "./session-accessor.sqlite-maintenance-kick.js";
import * as maintenance from "./session-accessor.sqlite-maintenance.js";
import { observeSessionMaintenancePlanningWorker } from "./session-accessor.sqlite-maintenance.test-support.js";
import * as reclamationRun from "./session-accessor.sqlite-reclamation-run.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

afterEach(() => vi.restoreAllMocks());

it.for([
  { owner: "canonical agent", alias: false },
  { owner: "aliased shared store", alias: true },
])(
  "joins active maintenance finalization during physical close ($owner)",
  async ({ alias }, test) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const options = {
        agentId: "main",
        env: state.env,
        ...(alias ? { path: state.path("relocated", "shared.sqlite") } : {}),
      };
      const database = openOpenClawAgentDatabase(options);
      const canonicalPath = fs.realpathSync.native(database.path);
      await closeOpenClawAgentDatabaseByPathAsync(database.path, "main");
      let requestedPath = canonicalPath;
      if (alias) {
        const aliasDirectory = state.path("shared-store-alias");
        fs.symlinkSync(path.dirname(canonicalPath), aliasDirectory, "junction");
        requestedPath = path.join(aliasDirectory, path.basename(canonicalPath));
      }
      const scope = {
        agentId: alias ? "other" : "main",
        databaseAgentId: "main",
        env: state.env,
        path: requestedPath,
      };
      const releaseFinalizer = createDeferredCore();
      const finalizerEntered = createDeferredCore<() => boolean>();
      const releaseAck = createDeferredCore();
      const releaseStarted = createDeferredCore<{ completion: Promise<void> }>();
      const closeEntered = createDeferredCore<{ completion: Promise<void> }>();
      let insideKick = false;
      let insideExecutorCapture = false;
      const captureExecution = databaseExecution.captureOpenClawAgentDatabaseExecution;
      vi.spyOn(databaseExecution, "captureOpenClawAgentDatabaseExecution").mockImplementation(
        (...args) => {
          if (!insideKick) {
            return captureExecution(...args);
          }
          insideExecutorCapture = true;
          let execution: ReturnType<typeof captureExecution>;
          try {
            execution = captureExecution(...args);
          } finally {
            insideExecutorCapture = false;
          }
          const release = execution.release.bind(execution);
          vi.spyOn(execution, "release").mockImplementation(() => {
            releaseStarted.resolve({ completion: release() });
            return releaseAck.promise;
          });
          return execution;
        },
      );
      const register = databaseResources.registerOpenClawAgentDatabaseAsyncResource;
      vi.spyOn(databaseResources, "registerOpenClawAgentDatabaseAsyncResource").mockImplementation(
        (resource) => {
          if (!insideKick || insideExecutorCapture || resource.path !== canonicalPath) {
            return register(resource);
          }
          return register({
            ...resource,
            close: () => {
              const completion = resource.close();
              closeEntered.resolve({ completion });
              return completion;
            },
          });
        },
      );
      const finalize = maintenance.finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort;
      let finalization: ReturnType<typeof finalize> | undefined;
      vi.spyOn(
        maintenance,
        "finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort",
      ).mockImplementation((...args) => {
        const isCurrent = args[2]?.isCurrent;
        if (!isCurrent) {
          throw new Error("Automatic maintenance omitted its live owner predicate");
        }
        finalizerEntered.resolve(isCurrent);
        finalization = (async () => {
          await releaseFinalizer.promise;
          return finalize(...args);
        })();
        return finalization;
      });
      const reclaim = vi.spyOn(reclamationRun, "runSqliteSessionReclamation");
      let nativeClosing: Promise<boolean> | undefined;
      try {
        insideKick = true;
        try {
          maintenanceKick.kickSessionEntryMaintenanceAfterWrite({
            activeSessionKey: `agent:${scope.agentId}:maintenance-close`,
            archiveDirectory: state.sessionsDir(),
            maintenanceConfig: resolveMaintenanceConfigFromInput({
              mode: "enforce",
              maxEntries: 100,
              pruneAfter: "1d",
            }),
            scope,
            storePath: requestedPath,
          });
        } finally {
          insideKick = false;
        }
        const isCurrent = await withinTest(finalizerEntered.promise, test.signal);
        expect(isCurrent()).toBe(true);
        const dispatchedBeforeClose = reclaim.mock.calls.length;
        nativeClosing = closeOpenClawAgentDatabaseByPathAsync(canonicalPath, "main");
        const { completion: schedulerClosing } = await withinTest(
          awaitGateBeforeSettlement(
            closeEntered.promise,
            nativeClosing,
            "Physical close skipped the maintenance scheduler",
          ),
          test.signal,
        );
        expect(isCurrent()).toBe(false);
        const { completion: released } = await withinTest(releaseStarted.promise, test.signal);
        await withinTest(released, test.signal);
        // Acknowledge real executor release before inspecting the scheduler's own
        // close promise; only the held finalizer may still keep that close pending.
        releaseAck.resolve();
        await releaseAck.promise;
        expect(await Promise.race([schedulerClosing, Promise.resolve("pending")])).toBe("pending");
        releaseFinalizer.resolve();
        await withinTest(Promise.all([nativeClosing, finalization]), test.signal);
        expect(reclaim).toHaveBeenCalledTimes(dispatchedBeforeClose);
      } finally {
        releaseAck.resolve();
        releaseFinalizer.resolve();
        await Promise.allSettled([nativeClosing, finalization]);
      }
    });
  },
);

it("records an in-flight Worker planning pass revoked by database close as retirement", async (test) => {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_FILE_LOG: "1" } },
    async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:maintenance-close-retirement",
      };
      ensureSessionEntrySync(scope, { sessionId: "retirement", updatedAt: Date.now() });
      const database = openOpenClawAgentDatabase(scope);
      const file = state.path("maintenance-close.log");
      fs.writeFileSync(file, "");
      setLoggerOverride({ level: "debug", consoleLevel: "silent", file });
      const closed = createDeferredCore();
      observeSessionMaintenancePlanningWorker({
        afterPrepare() {
          // One-shot CLI teardown revokes every agent database resource mid-pass.
          closed.resolve(closeOpenClawAgentDatabasesAsync());
        },
      });
      try {
        maintenanceKick.kickSessionEntryMaintenanceAfterWrite({
          activeSessionKey: scope.sessionKey,
          archiveDirectory: state.sessionsDir(),
          maintenanceConfig: resolveMaintenanceConfigFromInput({ mode: "enforce" }),
          scope: { agentId: scope.agentId, env: state.env, path: database.path },
          storePath: database.path,
        });
        // Close joins the scheduler's active pass, including its outcome logging.
        await withinTest(closed.promise, test.signal);
        await flushLogger();
        const messages = fs
          .readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => String((JSON.parse(line) as { message?: unknown }).message));
        // Child-logger records inline their metadata after the message text.
        const logged = (prefix: string) => messages.filter((message) => message.startsWith(prefix));
        expect(logged("SQLite reclamation Worker failed")).toEqual([]);
        expect(logged("slow SQLite reclamation Worker operation")).toEqual([]);
        expect(logged("SQLite automatic session maintenance failed")).toEqual([]);
        expect(
          logged("SQLite reclamation Worker request retired by its database owner"),
        ).toHaveLength(1);
        expect(
          logged("SQLite automatic session maintenance cancelled by database close"),
        ).toHaveLength(1);
      } finally {
        await flushLogger();
        setLoggerOverride(null);
      }
    },
  );
});
