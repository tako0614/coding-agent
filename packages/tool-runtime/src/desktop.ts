/**
 * Desktop control operations (screenshot, click, key input)
 * This module provides a unified interface for GUI automation
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const execAsync = promisify(exec);

export interface ScreenshotResult {
  width: number;
  height: number;
  path: string;
  base64?: string;
}

export interface ScreenSize {
  width: number;
  height: number;
}

export interface ClickOptions {
  button?: 'left' | 'right' | 'middle';
  doubleClick?: boolean;
}

export interface KeyOptions {
  modifiers?: Array<'ctrl' | 'alt' | 'shift' | 'meta'>;
}

/**
 * Desktop control class
 * Uses platform-specific tools for GUI automation
 */
export class DesktopControl {
  private platform: NodeJS.Platform;
  private screenshotDir: string;

  constructor() {
    this.platform = os.platform();
    this.screenshotDir = path.join(os.tmpdir(), 'supervisor-screenshots');
  }

  /**
   * Ensure screenshot directory exists
   */
  private async ensureScreenshotDir(): Promise<void> {
    await fs.mkdir(this.screenshotDir, { recursive: true });
  }

  /**
   * Take a screenshot
   */
  async takeScreenshot(filename?: string): Promise<ScreenshotResult> {
    await this.ensureScreenshotDir();

    const outputFile = path.join(
      this.screenshotDir,
      filename ?? `screenshot-${Date.now()}.png`
    );

    try {
      if (this.platform === 'darwin') {
        // macOS: use screencapture
        await execAsync(`screencapture -x "${outputFile}"`);
      } else if (this.platform === 'win32') {
        // Windows: use PowerShell
        const psScript = `
          Add-Type -AssemblyName System.Windows.Forms
          $screen = [System.Windows.Forms.Screen]::PrimaryScreen
          $bitmap = New-Object System.Drawing.Bitmap($screen.Bounds.Width, $screen.Bounds.Height)
          $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
          $graphics.CopyFromScreen($screen.Bounds.Location, [System.Drawing.Point]::Empty, $screen.Bounds.Size)
          $bitmap.Save("${outputFile.replace(/\\/g, '\\\\')}")
        `;
        await execAsync(`powershell -Command "${psScript.replace(/\n/g, ' ')}"`);
      } else {
        // Linux: try various tools
        try {
          await execAsync(`gnome-screenshot -f "${outputFile}"`);
        } catch {
          try {
            await execAsync(`scrot "${outputFile}"`);
          } catch {
            await execAsync(`import -window root "${outputFile}"`);
          }
        }
      }

      // Get image dimensions
      const stats = await fs.stat(outputFile);
      const imageData = await fs.readFile(outputFile);
      const base64 = imageData.toString('base64');

      // Try to get dimensions (basic approach)
      // For PNG, dimensions are at bytes 16-23
      let width = 0;
      let height = 0;
      if (imageData[0] === 0x89 && imageData[1] === 0x50) {
        // PNG signature
        width = imageData.readUInt32BE(16);
        height = imageData.readUInt32BE(20);
      }

      return {
        width,
        height,
        path: outputFile,
        base64,
      };
    } catch (error) {
      throw new Error(
        `Failed to take screenshot: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get screen size
   */
  async getScreenSize(): Promise<ScreenSize> {
    try {
      if (this.platform === 'darwin') {
        const { stdout } = await execAsync(
          "system_profiler SPDisplaysDataType | grep Resolution | head -1"
        );
        const match = stdout.match(/(\d+)\s*x\s*(\d+)/);
        if (match) {
          return { width: parseInt(match[1]!, 10), height: parseInt(match[2]!, 10) };
        }
      } else if (this.platform === 'win32') {
        const { stdout } = await execAsync(
          'powershell -Command "[System.Windows.Forms.Screen]::PrimaryScreen.Bounds | ConvertTo-Json"'
        );
        const bounds = JSON.parse(stdout);
        return { width: bounds.Width, height: bounds.Height };
      } else {
        const { stdout } = await execAsync('xdpyinfo | grep dimensions');
        const match = stdout.match(/(\d+)x(\d+)/);
        if (match) {
          return { width: parseInt(match[1]!, 10), height: parseInt(match[2]!, 10) };
        }
      }
    } catch {
      // Fallback
    }

    return { width: 1920, height: 1080 }; // Default fallback
  }

  /**
   * Click at screen coordinates
   */
  async click(x: number, y: number, options: ClickOptions = {}): Promise<void> {
    const { button = 'left', doubleClick = false } = options;

    try {
      if (this.platform === 'darwin') {
        // macOS: use cliclick
        const buttonFlag = button === 'right' ? 'rc' : doubleClick ? 'dc' : 'c';
        await execAsync(`cliclick ${buttonFlag}:${x},${y}`);
      } else if (this.platform === 'win32') {
        // Windows: use PowerShell with SendInput
        const buttonCode = button === 'right' ? '0x0008' : '0x0002';
        const releaseCode = button === 'right' ? '0x0010' : '0x0004';
        const psScript = `
          Add-Type -TypeDefinition @"
          using System;
          using System.Runtime.InteropServices;
          public class Mouse {
              [DllImport("user32.dll")]
              public static extern bool SetCursorPos(int x, int y);
              [DllImport("user32.dll")]
              public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
          }
"@
          [Mouse]::SetCursorPos(${x}, ${y})
          [Mouse]::mouse_event(${buttonCode}, 0, 0, 0, 0)
          [Mouse]::mouse_event(${releaseCode}, 0, 0, 0, 0)
          ${doubleClick ? `
          Start-Sleep -Milliseconds 50
          [Mouse]::mouse_event(${buttonCode}, 0, 0, 0, 0)
          [Mouse]::mouse_event(${releaseCode}, 0, 0, 0, 0)
          ` : ''}
        `;
        await execAsync(`powershell -Command "${psScript.replace(/\n/g, ' ')}"`);
      } else {
        // Linux: use xdotool
        const buttonNum = button === 'right' ? 3 : button === 'middle' ? 2 : 1;
        const clickCmd = doubleClick ? `click --repeat 2 ${buttonNum}` : `click ${buttonNum}`;
        await execAsync(`xdotool mousemove ${x} ${y} ${clickCmd}`);
      }
    } catch (error) {
      throw new Error(
        `Failed to click: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Type text
   */
  async typeText(text: string): Promise<void> {
    try {
      if (this.platform === 'darwin') {
        // macOS: use cliclick
        await execAsync(`cliclick t:"${text.replace(/"/g, '\\"')}"`);
      } else if (this.platform === 'win32') {
        // Windows: use PowerShell SendKeys
        const psScript = `
          Add-Type -AssemblyName System.Windows.Forms
          [System.Windows.Forms.SendKeys]::SendWait("${text.replace(/"/g, '`"').replace(/\+/g, '{+}').replace(/\^/g, '{^}').replace(/%/g, '{%}')}")
        `;
        await execAsync(`powershell -Command "${psScript}"`);
      } else {
        // Linux: use xdotool
        await execAsync(`xdotool type "${text.replace(/"/g, '\\"')}"`);
      }
    } catch (error) {
      throw new Error(
        `Failed to type text: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Press a key
   */
  async keyPress(key: string, options: KeyOptions = {}): Promise<void> {
    const { modifiers = [] } = options;

    try {
      if (this.platform === 'darwin') {
        // macOS: use cliclick
        const modStr = modifiers.map(m => {
          switch (m) {
            case 'ctrl': return 'ctrl';
            case 'alt': return 'alt';
            case 'shift': return 'shift';
            case 'meta': return 'cmd';
            default: return '';
          }
        }).filter(Boolean).join(',');

        const keyCmd = modStr ? `kp:${modStr}+${key}` : `kp:${key}`;
        await execAsync(`cliclick ${keyCmd}`);
      } else if (this.platform === 'win32') {
        // Windows: use PowerShell SendKeys
        let keyStr = key;
        for (const mod of modifiers) {
          switch (mod) {
            case 'ctrl': keyStr = `^${keyStr}`; break;
            case 'alt': keyStr = `%${keyStr}`; break;
            case 'shift': keyStr = `+${keyStr}`; break;
            case 'meta': keyStr = `^{ESC}${keyStr}`; break; // Win key approximation
          }
        }
        const psScript = `
          Add-Type -AssemblyName System.Windows.Forms
          [System.Windows.Forms.SendKeys]::SendWait("{${keyStr}}")
        `;
        await execAsync(`powershell -Command "${psScript}"`);
      } else {
        // Linux: use xdotool
        const modStr = modifiers.map(m => {
          switch (m) {
            case 'ctrl': return 'ctrl';
            case 'alt': return 'alt';
            case 'shift': return 'shift';
            case 'meta': return 'super';
            default: return '';
          }
        }).filter(Boolean).join('+');

        const keyCmd = modStr ? `${modStr}+${key}` : key;
        await execAsync(`xdotool key ${keyCmd}`);
      }
    } catch (error) {
      throw new Error(
        `Failed to press key: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get list of screenshots
   */
  async listScreenshots(): Promise<string[]> {
    await this.ensureScreenshotDir();
    const files = await fs.readdir(this.screenshotDir);
    return files
      .filter(f => f.endsWith('.png'))
      .map(f => path.join(this.screenshotDir, f));
  }

  /**
   * Delete old screenshots
   */
  async cleanupScreenshots(maxAge: number = 3600000): Promise<number> {
    const files = await this.listScreenshots();
    const now = Date.now();
    let deleted = 0;

    for (const file of files) {
      const stats = await fs.stat(file);
      if (now - stats.mtimeMs > maxAge) {
        await fs.unlink(file);
        deleted++;
      }
    }

    return deleted;
  }
}

/**
 * Create a desktop control instance
 */
export function createDesktopControl(): DesktopControl {
  return new DesktopControl();
}
