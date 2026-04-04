/**
 * AXME Code CLI - setup and management commands.
 *
 * Commands:
 *   axme-code setup [path]   - Create .mcp.json and init .axme-code/
 *   axme-code serve           - Start MCP server (stdio, used by .mcp.json)
 *   axme-code status [path]   - Show project status
 */

import { resolve, join } from "node:path";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { initProjectDeterministic } from "./tools/init.js";
import { statusTool } from "./tools/status.js";

const args = process.argv.slice(2);
const command = args[0];

function usage(): void {
  console.log(`AXME Code - MCP server for Claude Code CLI

Usage:
  axme-code setup [path]    Initialize project and create .mcp.json
  axme-code serve           Start MCP server (stdio transport)
  axme-code status [path]   Show project status
  axme-code help            Show this help

After setup, run 'claude' as usual. AXME tools are available automatically.`);
}

async function main() {
  switch (command) {
    case "setup": {
      const projectPath = resolve(args[1] || ".");
      console.log(`Initializing AXME Code in ${projectPath}...`);

      // Init .axme-code/ (deterministic only, LLM scan runs via axme_init tool in Claude)
      const result = initProjectDeterministic(projectPath);
      console.log(`  Oracle: ${result.oracle.files} files (deterministic - run axme_init in Claude for LLM scan)`);
      console.log(`  Decisions: ${result.decisions.count} (${result.decisions.fromPresets} from presets)`);
      console.log(`  Memories: ${result.memories.count} (${result.memories.fromPresets} from presets)`);
      console.log(`  Safety: ${result.safety.created ? "created" : "exists"}`);

      // Create or update .mcp.json
      const mcpPath = join(projectPath, ".mcp.json");
      let mcpConfig: Record<string, any> = {};

      if (existsSync(mcpPath)) {
        try {
          mcpConfig = JSON.parse(readFileSync(mcpPath, "utf-8"));
        } catch {
          mcpConfig = {};
        }
      }

      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
      mcpConfig.mcpServers.axme = {
        command: "axme-code",
        args: ["serve"],
      };

      writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n", "utf-8");
      console.log(`  .mcp.json: ${existsSync(mcpPath) ? "updated" : "created"}`);

      // Add .axme-code/ to .gitignore if not already there
      const gitignorePath = join(projectPath, ".gitignore");
      if (existsSync(gitignorePath)) {
        const content = readFileSync(gitignorePath, "utf-8");
        if (!content.includes(".axme-code")) {
          writeFileSync(gitignorePath, content.trimEnd() + "\n.axme-code/\n", "utf-8");
          console.log("  .gitignore: added .axme-code/");
        }
      } else {
        writeFileSync(gitignorePath, ".axme-code/\n", "utf-8");
        console.log("  .gitignore: created with .axme-code/");
      }

      console.log("\nDone! Run 'claude' to start using AXME tools.");
      break;
    }

    case "serve": {
      // Import and start MCP server
      await import("./server.js");
      break;
    }

    case "status": {
      const projectPath = resolve(args[1] || ".");
      console.log(statusTool(projectPath));
      break;
    }

    case "hook": {
      // Hook subcommands: axme-code hook <hook-name> <json>
      const hookName = args[1];
      if (hookName === "post-tool-use") {
        const { runPostToolUseHook } = await import("./hooks/post-tool-use.js");
        await runPostToolUseHook();
      } else if (hookName === "session-end") {
        const { runSessionEndHook } = await import("./hooks/session-end.js");
        await runSessionEndHook();
      }
      break;
    }

    case "help":
    case "--help":
    case "-h":
    case undefined: {
      usage();
      break;
    }

    default: {
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
