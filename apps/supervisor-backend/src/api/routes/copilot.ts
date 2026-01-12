/**
 * Copilot API management routes
 */

import { Hono } from 'hono';
import { copilotAPIManager } from '../../services/copilot-api-manager.js';
import { getCopilotAPIConfig } from '../../services/settings-store.js';
import { logger } from '../../services/logger.js';

const copilot = new Hono();

/**
 * GET /api/copilot/status
 * Get copilot-api proxy status
 */
copilot.get('/status', async (c) => {
  const status = copilotAPIManager.getStatus();
  const config = getCopilotAPIConfig();
  const healthy = status.running ? await copilotAPIManager.checkHealth() : false;

  return c.json({
    ...status,
    enabled: config.enabled,
    configured_url: config.baseUrl,
    healthy,
  });
});

/**
 * POST /api/copilot/start
 * Start the copilot-api proxy
 */
copilot.post('/start', async (c) => {
  try {
    const status = await copilotAPIManager.start();
    return c.json(status);
  } catch (error) {
    logger.error('Copilot error starting', { error: error instanceof Error ? error.message : String(error) });
    return c.json({
      running: false,
      error: error instanceof Error ? error.message : 'Failed to start copilot-api',
    }, 500);
  }
});

/**
 * POST /api/copilot/stop
 * Stop the copilot-api proxy
 */
copilot.post('/stop', async (c) => {
  try {
    const status = await copilotAPIManager.stop();
    return c.json(status);
  } catch (error) {
    logger.error('Copilot error stopping', { error: error instanceof Error ? error.message : String(error) });
    return c.json({
      running: false,
      error: error instanceof Error ? error.message : 'Failed to stop copilot-api',
    }, 500);
  }
});

/**
 * POST /api/copilot/restart
 * Restart the copilot-api proxy
 */
copilot.post('/restart', async (c) => {
  try {
    await copilotAPIManager.stop();
    const status = await copilotAPIManager.start();
    return c.json(status);
  } catch (error) {
    logger.error('Copilot error restarting', { error: error instanceof Error ? error.message : String(error) });
    return c.json({
      running: false,
      error: error instanceof Error ? error.message : 'Failed to restart copilot-api',
    }, 500);
  }
});

/**
 * GET /api/copilot/health
 * Check if the copilot-api is healthy
 */
copilot.get('/health', async (c) => {
  const healthy = await copilotAPIManager.checkHealth();
  return c.json({ healthy });
});

/**
 * GET /api/copilot/models
 * Get available models from copilot-api
 */
copilot.get('/models', async (c) => {
  const models = await copilotAPIManager.fetchModels();
  return c.json({ models });
});

export { copilot };
