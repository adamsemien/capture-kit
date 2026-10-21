#!/usr/bin/env node
import { runMcpServer } from '../src/mcp.mjs';

runMcpServer().catch((error) => {
  console.error(`[capture-kit] MCP server failed: ${error?.message ?? error}`);
  process.exit(1);
});
