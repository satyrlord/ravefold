# RaveFold

RaveFold is a music project for web browsers. It uses audio samples to make rave
music at 180 BPM in C minor.

## Use the tracker inside VS Code

The local development mode works with the built-in Integrated Browser. The local
server supplies folder access when the browser cannot grant file permissions.

1. Install Node.js 24 or later.
2. Run `npm ci` in the project folder.
3. Set `SAMPLES_DIR` and `SETTINGS_DIR` in your private `.env.local` file.
4. Use existing, separate folders that do not contain each other.
5. Run `npm run dev:local`.
6. Open **Browser: Open Integrated Browser** from the VS Code command palette.
7. Open the local URL printed by the development server.
8. Select **New project**.
9. Select **Enter tracker** after the folder checks pass.

The sample folder must contain supported WAV audio. The settings folder must be
writable. The application loads these configured folders on each page load.
Folder controls use the same configured folders. Restart the server after you
change `.env.local`.

Tag edits and appearance changes save to the configured folders. Archive import
can add new WAV files. Existing audio cannot be overwritten or deleted. Use
dedicated test folders when you do not want changes to your usual metadata.

Folder paths stay on the local server. This mode listens on `127.0.0.1` only.
Stop the terminal command with `Ctrl+C` when you finish.

## Use a standalone browser

Run `npm run dev` and open its URL in a Chromium desktop browser. Select folders
through the browser controls. Production builds use this browser access method.
The local folder adapter is absent from production builds.
