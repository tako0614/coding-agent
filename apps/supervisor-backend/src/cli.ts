#!/usr/bin/env node
/**
 * Supervisor CLI
 * Command-line interface for running the supervisor
 */

import { runSimplifiedSupervisor } from './graph/index.js';

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Supervisor Agent CLI

Usage:
  supervisor <command> [options]

Commands:
  run <goal>              Run the supervisor with a goal
  serve                   Start the API server

Options:
  --repo <path>           Repository path (default: current directory)
  --port <number>         Server port (default: 3000)
  -h, --help              Show this help message

Examples:
  supervisor run "Add a login button to the homepage"
  supervisor run "Fix the failing tests" --repo /path/to/project
  supervisor serve --port 8080
    `);
    process.exit(0);
  }

  const command = args[0];

  switch (command) {
    case 'run': {
      const goalIndex = 1;
      const goal = args[goalIndex];

      if (!goal) {
        console.error('Error: Missing goal argument');
        console.error('Usage: supervisor run "Your goal here"');
        process.exit(1);
      }

      // Parse options
      const repoIndex = args.indexOf('--repo');
      const repoPath = repoIndex !== -1 ? args[repoIndex + 1] : process.cwd();

      if (!repoPath) {
        console.error('Error: --repo requires a path argument');
        process.exit(1);
      }

      console.log('Starting supervisor run...');
      console.log(`Goal: ${goal}`);
      console.log(`Repository: ${repoPath}`);
      console.log('');

      try {
        const finalState = await runSimplifiedSupervisor({
          userGoal: goal,
          repoPath: repoPath,
        });

        console.log('');
        console.log('=' .repeat(60));
        console.log('RUN COMPLETED');
        console.log('=' .repeat(60));
        console.log(`Status: ${finalState.status}`);
        console.log(`Run ID: ${finalState.run_id}`);

        if (finalState.error) {
          console.log(`Error: ${finalState.error}`);
        }

        if (finalState.final_summary) {
          console.log('');
          console.log('FINAL SUMMARY:');
          console.log('-'.repeat(60));
          console.log(finalState.final_summary);
        }

        process.exit(finalState.status === 'completed' ? 0 : 1);
      } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
      }
      break;
    }

    case 'serve': {
      // Parse options
      const portIndex = args.indexOf('--port');
      const port = portIndex !== -1 ? args[portIndex + 1] : '3000';

      process.env['PORT'] = port ?? '3000';

      // Dynamic import to start server
      await import('./server.js');
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "supervisor --help" for usage information');
      process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
