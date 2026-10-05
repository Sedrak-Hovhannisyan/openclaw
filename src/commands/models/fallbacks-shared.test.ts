import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerModelsCli } from "../../cli/models-cli.js";
import type { ConfigFileSnapshot, TransformConfigFileParams } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import { runRegisteredCli } from "../../test-utils/command-runner.js";

const mocks = vi.hoisted(() => ({
  loadModelsConfig: vi.fn(),
  writtenConfig: undefined as unknown,
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    transformConfigFile: async ({
      transform,
    }: TransformConfigFileParams<unknown>): Promise<{ nextConfig: unknown; result: unknown }> => {
      const snapshot: ConfigFileSnapshot = {
        path: "/tmp/openclaw-fallbacks-fixture.json",
        exists: true,
        raw: "{}",
        parsed: {},
        valid: true,
        hash: "config-hash",
        sourceConfig: {},
        resolved: {},
        runtimeConfig: {},
        config: {},
        issues: [],
        warnings: [],
        legacyIssues: [],
      };
      const { nextConfig, result } = await transform(
        {},
        { snapshot, previousHash: snapshot.hash ?? null, attempt: 0 },
        {},
      );
      mocks.writtenConfig = nextConfig;
      return { nextConfig, result };
    },
  };
});

describe.each([
  {
    name: "fallbacks",
    label: "Fallbacks",
    key: "model" as const,
    model: "anthropic/claude-sonnet-4-6",
  },
  {
    name: "image-fallbacks",
    label: "Image fallbacks",
    key: "imageModel" as const,
    model: "openai/gpt-image-1",
  },
])("models $name list", (testCase) => {
  beforeEach(() => {
    mocks.loadModelsConfig.mockReset();
    mocks.loadModelsConfig.mockResolvedValue({
      agents: {
        defaults: {
          [testCase.key]: { fallbacks: [testCase.model] },
        },
      },
    });
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "writeStdout").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["--json", testCase.name, "list"],
    [testCase.name, "list", "--json"],
  ])("writes JSON and attributes diagnostics for %s %s %s", async (...args) => {
    await runRegisteredCli({ register: registerModelsCli, argv: ["models", ...args] });

    expect(mocks.loadModelsConfig).toHaveBeenCalledWith({
      commandName: `models ${testCase.name} list`,
      runtime: defaultRuntime,
    });
    expect(vi.mocked(defaultRuntime.writeJson).mock.calls.map(([value]) => value)).toEqual([
      {
        fallbacks: [testCase.model],
      },
    ]);
    expect(defaultRuntime.log).not.toHaveBeenCalled();
  });

  it("writes populated plain output directly to stdout", async () => {
    await runRegisteredCli({
      register: registerModelsCli,
      argv: ["models", testCase.name, "list", "--plain"],
    });

    expect(defaultRuntime.writeStdout).toHaveBeenCalledExactlyOnceWith(testCase.model);
    expect(defaultRuntime.log).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves human output (empty: %s)", async (empty) => {
    if (empty) {
      mocks.loadModelsConfig.mockResolvedValue({});
    }
    await runRegisteredCli({
      register: registerModelsCli,
      argv: ["models", testCase.name, "list"],
    });

    expect(vi.mocked(defaultRuntime.log).mock.calls).toEqual([
      [`${testCase.label} (${empty ? 0 : 1}):`],
      [empty ? "- none" : `- ${testCase.model}`],
    ]);
  });
});

describe.each(["fallbacks", "image-fallbacks"])("models %s add", (name) => {
  beforeEach(() => {
    mocks.writtenConfig = undefined;
  });

  afterEach(() => vi.restoreAllMocks());

  it("rejects an unknown provider without writing config", async () => {
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
      throw new Error("CLI exit");
    });

    await expect(
      runRegisteredCli({
        register: registerModelsCli,
        argv: ["models", name, "add", "no-such-provider/no-such-model"],
      }),
    ).rejects.toThrow("CLI exit");

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown model provider "no-such-provider"'),
    );
    expect(mocks.writtenConfig).toBeUndefined();
  });
});
