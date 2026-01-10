/**
 * Desktop control API routes
 * Screenshot, click, and keyboard input
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createDesktopControl } from '@supervisor/tool-runtime';

const desktop = new Hono();
const control = createDesktopControl();

/**
 * GET /api/desktop/screenshot
 * Take a screenshot
 */
desktop.get('/screenshot', async (c) => {
  try {
    const result = await control.takeScreenshot();

    return c.json({
      success: true,
      screenshot: {
        width: result.width,
        height: result.height,
        path: result.path,
        data: result.base64 ? `data:image/png;base64,${result.base64}` : undefined,
      },
    });
  } catch (error) {
    return c.json({
      error: {
        message: error instanceof Error ? error.message : 'Failed to take screenshot',
      },
    }, 500);
  }
});

/**
 * GET /api/desktop/screen-size
 * Get screen dimensions
 */
desktop.get('/screen-size', async (c) => {
  try {
    const size = await control.getScreenSize();
    return c.json(size);
  } catch (error) {
    return c.json({
      error: {
        message: error instanceof Error ? error.message : 'Failed to get screen size',
      },
    }, 500);
  }
});

const ClickSchema = z.object({
  x: z.number(),
  y: z.number(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  doubleClick: z.boolean().optional(),
});

/**
 * POST /api/desktop/click
 * Click at screen coordinates
 */
desktop.post('/click', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = ClickSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({
        error: {
          message: 'Invalid request body',
          details: parsed.error.errors,
        },
      }, 400);
    }

    const { x, y, button, doubleClick } = parsed.data;
    await control.click(x, y, { button, doubleClick });

    return c.json({ success: true });
  } catch (error) {
    return c.json({
      error: {
        message: error instanceof Error ? error.message : 'Failed to click',
      },
    }, 500);
  }
});

const TypeSchema = z.object({
  text: z.string(),
});

/**
 * POST /api/desktop/type
 * Type text
 */
desktop.post('/type', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = TypeSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({
        error: {
          message: 'Invalid request body',
          details: parsed.error.errors,
        },
      }, 400);
    }

    await control.typeText(parsed.data.text);

    return c.json({ success: true });
  } catch (error) {
    return c.json({
      error: {
        message: error instanceof Error ? error.message : 'Failed to type text',
      },
    }, 500);
  }
});

const KeyPressSchema = z.object({
  key: z.string(),
  modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'meta'])).optional(),
});

/**
 * POST /api/desktop/key
 * Press a key
 */
desktop.post('/key', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = KeyPressSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({
        error: {
          message: 'Invalid request body',
          details: parsed.error.errors,
        },
      }, 400);
    }

    await control.keyPress(parsed.data.key, { modifiers: parsed.data.modifiers });

    return c.json({ success: true });
  } catch (error) {
    return c.json({
      error: {
        message: error instanceof Error ? error.message : 'Failed to press key',
      },
    }, 500);
  }
});

/**
 * GET /api/desktop/screenshots
 * List available screenshots
 */
desktop.get('/screenshots', async (c) => {
  try {
    const files = await control.listScreenshots();
    return c.json({ screenshots: files });
  } catch (error) {
    return c.json({
      error: {
        message: error instanceof Error ? error.message : 'Failed to list screenshots',
      },
    }, 500);
  }
});

/**
 * DELETE /api/desktop/screenshots
 * Clean up old screenshots
 */
desktop.delete('/screenshots', async (c) => {
  try {
    const maxAge = parseInt(c.req.query('maxAge') ?? '3600000', 10);
    const deleted = await control.cleanupScreenshots(maxAge);
    return c.json({ deleted });
  } catch (error) {
    return c.json({
      error: {
        message: error instanceof Error ? error.message : 'Failed to cleanup screenshots',
      },
    }, 500);
  }
});

export { desktop };
