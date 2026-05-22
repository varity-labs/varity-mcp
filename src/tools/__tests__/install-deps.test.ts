import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInstallDepsTool } from "../install-deps.js";
import * as cliBridge from "../../utils/cli-bridge.js";

vi.mock("../../utils/cli-bridge.js", () => ({
  execCLI: vi.fn(),
}));

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

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

function parseResponse(result: Awaited<ReturnType<ToolHandler>>) {
  return JSON.parse(result.content[0]!.text);
}

async function createUsableNextInstall(projectDir: string) {
  await mkdir(join(projectDir, "node_modules", ".bin"), { recursive: true });
  await mkdir(join(projectDir, "node_modules", "next", "dist", "bin"), { recursive: true });
  const binPaths = [
    join(projectDir, "node_modules", ".bin", "next"),
    join(projectDir, "node_modules", "next", "dist", "bin", "next"),
  ];
  for (const binPath of binPaths) {
    await writeFile(binPath, "#!/usr/bin/env node\nconsole.log('next')\n", "utf-8");
    await chmod(binPath, 0o755);
  }
}

describe("varity_install_deps", () => {
  let server: MockMcpServer;
  let tempDirs: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    server = new MockMcpServer();
    tempDirs = [];
    registerInstallDepsTool(server as never);
  });

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeProject() {
    const dir = await mkdtemp(join(tmpdir(), "varity-mcp-install-deps-"));
    tempDirs.push(dir);
    return dir;
  }

  it("installs Python pyproject projects with pip editable mode", async () => {
    const projectDir = await makeProject();
    await writeFile(
      join(projectDir, "pyproject.toml"),
      "[project]\nname = \"python-app\"\nversion = \"0.1.0\"\n",
      "utf-8"
    );

    vi.mocked(cliBridge.execCLI).mockResolvedValue({
      exitCode: 0,
      stdout: "installed",
      stderr: "",
    });

    const response = parseResponse(await server.handler({ path: projectDir }));

    expect(response.success).toBe(true);
    expect(response.data.framework).toBe("python");
    expect(cliBridge.execCLI).toHaveBeenCalledWith("pip", ["install", "-e", "."], {
      cwd: projectDir,
      timeout: 120_000,
    });
  });

  it("cleans and repairs non-executable Next.js binaries before reporting success", async () => {
    const projectDir = await makeProject();
    await writeFile(
      join(projectDir, "package.json"),
      JSON.stringify({
        scripts: { build: "next build" },
        dependencies: { next: "15.0.0" },
      }),
      "utf-8"
    );

    await mkdir(join(projectDir, "node_modules", ".bin"), { recursive: true });
    for (const name of [".package-lock.json", "react", "react-dom", "zod"]) {
      await writeFile(join(projectDir, "node_modules", name), "", "utf-8");
    }
    await mkdir(join(projectDir, "node_modules", "next"), { recursive: true });
    const brokenNext = join(projectDir, "node_modules", ".bin", "next");
    await writeFile(brokenNext, "#!/usr/bin/env node\nconsole.log('next')\n", "utf-8");
    await chmod(brokenNext, 0o644);

    vi.mocked(cliBridge.execCLI).mockImplementation(async (command, _args, options) => {
      expect(command).toBe("npm");
      await createUsableNextInstall(options?.cwd ?? projectDir);
      return { exitCode: 0, stdout: "added 42 packages", stderr: "" };
    });

    const response = parseResponse(await server.handler({ path: projectDir }));

    expect(response.success).toBe(true);
    expect(response.data.package_count).toBe(42);
    await expect(readFile(brokenNext, "utf-8")).resolves.toContain("next");
    const nextMode = (await stat(brokenNext)).mode;
    expect(nextMode & 0o111).not.toBe(0);
    expect(cliBridge.execCLI).toHaveBeenCalledWith("npm", ["install", "--legacy-peer-deps", "--bin-links"], {
      cwd: projectDir,
      timeout: 300_000,
    });
  });
});
