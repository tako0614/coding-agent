# Desktop App Resources

This folder contains the application icons used for the Electron desktop app.

## Required Icons

- `icon.ico` - Windows icon (256x256 recommended, with multiple sizes embedded)
- `icon.icns` - macOS icon (512x512 recommended)
- `icon.png` - Linux/fallback icon (512x512 recommended)

## Creating Icons

You can use tools like:
- [electron-icon-builder](https://www.npmjs.com/package/electron-icon-builder)
- [Icon Factory](https://icons8.com/icon-factory)
- [Iconvert Icons](https://iconverticons.com/)

### From PNG

```bash
# Using electron-icon-builder
npx electron-icon-builder --input=./icon-source.png --output=./resources
```

## Notes

- The icons should be square
- Use a simple, recognizable design that looks good at small sizes (16x16 for system tray)
- Test the icon at various sizes before release
