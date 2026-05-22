/**
 * Regression tests for VAR-145: varity_deploy app_name parameter silently ignored.
 *
 * Verifies that when app_name is provided to varity_deploy, the --name flag is
 * forwarded to the varitykit CLI so the deployment URL reflects the custom name.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerDeployTool } from "../deploy.js";
import * as cliBridge from "../../utils/cli-bridge.js";
import * as fsPromises from "node:fs/promises";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../utils/cli-bridge.js", () => ({
  execVaritykit: vi.fn(),
  execCLI: vi.fn(),
  isCLIAvailable: vi.fn(),
}));

vi.mock("../../utils/config.js", () => ({
  getDeploymentsDir: () => "/tmp/test-deployments",
}));

vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Minimal McpServer stub
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

class MockMcpServer {
  private _handler: ToolHandler | null = null;

  registerTool(_name: string, _config: unknown, handler: ToolHandler) {
    this._handler = handler;
  }

  get handler(): ToolHandler {
    if (!this._handler) throw new Error("No tool registered");
    return this._handler;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("varity_deploy app_name parameter (VAR-145)", () => {
  let server: MockMcpServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new MockMcpServer();
    registerDeployTool(server as never);

    const mockedExecCLI = vi.mocked(cliBridge.execCLI);
    mockedExecCLI.mockImplementation(async (cmd: string, args: string[] = []) => {
      if (cmd === "python3" && args[0] === "--version") {
        return { exitCode: 0, stdout: "Python 3.11.0", stderr: "" };
      }
      if (cmd === "git") return { exitCode: 1, stdout: "", stderr: "" };
      if (cmd === "du") return { exitCode: 0, stdout: "1.2M\t.", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    vi.mocked(cliBridge.isCLIAvailable).mockResolvedValue(true);
    vi.mocked(cliBridge.execVaritykit).mockResolvedValue({
      exitCode: 0,
      stdout: "✅ Deployed! URL: https://varity.app/test-app/",
      stderr: "",
    });

    vi.mocked(fsPromises.access).mockResolvedValue(undefined);
    vi.mocked(fsPromises.readFile).mockResolvedValue(
      '{"name":"test-app","scripts":{}}' as never
    );
    vi.mocked(fsPromises.readdir).mockResolvedValue([] as never);
    vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined as never);
  });

  it("passes --name to CLI when app_name is provided", async () => {
    await server.handler({ path: "/tmp/test-app", app_name: "my-custom-name" });

    expect(cliBridge.execVaritykit).toHaveBeenCalled();
    const [, args] = vi.mocked(cliBridge.execVaritykit).mock.calls[0] as [
      string,
      string[],
    ];
    expect(args).toContain("--name");
    const nameIdx = args.indexOf("--name");
    expect(args[nameIdx + 1]).toBe("my-custom-name");
  });

  it("does NOT pass --name to CLI when app_name is omitted", async () => {
    await server.handler({ path: "/tmp/test-app" });

    expect(cliBridge.execVaritykit).toHaveBeenCalled();
    const [, args] = vi.mocked(cliBridge.execVaritykit).mock.calls[0] as [
      string,
      string[],
    ];
    expect(args).not.toContain("--name");
  });
});
