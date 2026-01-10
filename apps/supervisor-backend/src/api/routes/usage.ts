/**
 * Usage API routes
 * Provides usage statistics and model routing info
 */

import { Hono } from 'hono';
import { getModelRouter } from '../../services/model-router.js';

const usage = new Hono();

/**
 * GET /api/usage
 * Get current usage statistics
 */
usage.get('/', async (c) => {
  const router = getModelRouter();
  const stats = await router.getUsageStats();

  return c.json(stats);
});

/**
 * GET /api/usage/model
 * Get recommended model for current usage level
 */
usage.get('/model', async (c) => {
  const taskType = c.req.query('task') as 'supervisor' | 'executor' | undefined;
  const router = getModelRouter();
  const selection = await router.selectModel(taskType ?? 'executor');

  return c.json(selection);
});

/**
 * GET /api/usage/copilot/status
 * Check Copilot API availability
 */
usage.get('/copilot/status', async (c) => {
  const router = getModelRouter();
  const available = await router.checkCopilotAvailability();

  return c.json({
    available,
    message: available
      ? 'Copilot API is available'
      : 'Copilot API is not available or not configured',
  });
});

export { usage };
