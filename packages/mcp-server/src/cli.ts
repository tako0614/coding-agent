#!/usr/bin/env node
/**
 * MCP Server CLI
 */

import { runStdioServer } from './server.js';
import { startHTTPServer } from './http-server.js';

const args = process.argv.slice(2);

// Single-pass argument parsing for O(n) instead of O(n*m)
let isHttpMode = false;
let portValue = '3001';
let supervisorValue = 'http://localhost:3000';
let tokenValue: string | undefined;
let showHelp = false;

for (const arg of args) {
  if (arg === '--http') {
    isHttpMode = true;
  } else if (arg === '--help' || arg === '-h') {
    showHelp = true;
  } else if (arg.startsWith('--port=')) {
    portValue = arg.slice(7);
  } else if (arg.startsWith('--supervisor=')) {
    supervisorValue = arg.slice(13);
  } else if (arg.startsWith('--token=')) {
    tokenValue = arg.slice(8);
  }
}

const mode = isHttpMode ? 'http' : 'stdio';
const port = parseInt(portValue, 10);
const supervisorUrl = supervisorValue;
const accessToken = tokenValue;

if (showHelp) {
  console.log(`
Supervisor MCP Server

Usage:
  supervisor-mcp [options]

Options:
  --http              Run as HTTP server (default: stdio)
  --port=PORT         HTTP server port (default: 3001)
  --supervisor=URL    Supervisor backend URL (default: http://localhost:3000)
  --token=TOKEN       Access token for authentication
  --help, -h          Show this help

Examples:
  # Run as stdio server (for MCP clients)
  supervisor-mcp

  # Run as HTTP server with OAuth
  supervisor-mcp --http --port=3001

  # Connect to different supervisor
  supervisor-mcp --supervisor=http://localhost:4000
`);
  process.exit(0);
}

async function main(): Promise<void> {
  if (mode === 'http') {
    await startHTTPServer({ port, supervisorUrl });
  } else {
    await runStdioServer({ supervisorUrl, accessToken });
  }
}

main().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
