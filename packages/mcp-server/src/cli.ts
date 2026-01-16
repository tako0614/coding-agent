#!/usr/bin/env node
/**
 * MCP Server CLI
 */

import { runStdioServer } from './server.js';
import { startHTTPServer } from './http-server.js';

const args = process.argv.slice(2);

const mode = args.includes('--http') ? 'http' : 'stdio';
const port = parseInt(args.find(a => a.startsWith('--port='))?.split('=')[1] ?? '3001', 10);
const supervisorUrl = args.find(a => a.startsWith('--supervisor='))?.split('=')[1] ?? 'http://localhost:3000';
const accessToken = args.find(a => a.startsWith('--token='))?.split('=')[1];

if (args.includes('--help') || args.includes('-h')) {
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
