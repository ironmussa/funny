# Funny - UI Annotator (Chrome Extension)

Select and annotate UI elements on any webpage, then send them to Funny for AI-powered analysis and fixes.

## Development

### Prerequisites

- [Bun](https://bun.sh/) installed
- Dependencies installed from the monorepo root: `bun install`

### Build

```bash
cd packages/chrome-extension
bun run build
```

### Watch mode (auto-rebuild on changes)

```bash
cd packages/chrome-extension
bun run watch
```

### Load in Chrome (unpacked)

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `packages/chrome-extension` folder
5. The extension icon appears in the toolbar

After rebuilding, click the reload button on the extension card in `chrome://extensions/` to pick up changes.

## Distributing to testers

### Option A: Share as .zip (sideload)

Build and package the extension into a zip file:

```bash
cd packages/chrome-extension
bun run build
bun run package
```

This creates `funny-annotator-v0.1.0.zip` in the extension folder. Send that file to testers.

**Testers install it by:**

1. Unzip the file to a folder
2. Open `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the unzipped folder

### Option B: Publish to Chrome Web Store

1. **Create a developer account** at https://chrome.google.com/webstore/devconsole (one-time $5 fee)

2. **Build and package:**

   ```bash
   cd packages/chrome-extension
   bun run build
   bun run package
   ```

3. **Upload** `funny-annotator-v0.1.0.zip` in the developer console:
   - Click **New Item** > upload the zip
   - Fill in the listing details (description, screenshots, category)
   - Set **Visibility** to **Unlisted** for private testing, or **Public** for everyone

4. **Submit for review** — Google reviews typically take 1-3 business days

5. **Share the link** — once approved, share the Chrome Web Store URL with users

### What goes in the zip

The zip only needs the runtime files (no source code or node_modules):

```
manifest.json
background.js
content.js
content.css
page-bridge.js
popup.html
popup.js
icons/
  icon16.png
  icon48.png
  icon128.png
```

## Configuration

After installing, click the extension icon to open the popup and configure:

- **Server URL** — The Funny server address (default: `http://localhost:3001`)
- **Project** — Which Funny project to send annotations to
- **Provider / Model** — AI provider and model for the created thread
- **Mode** — `local` (work in project dir) or `worktree` (isolated branch)

Click **Test Connection** to verify the server is reachable.

## Usage

1. Click the extension icon or use the popup's **Start Annotating** button
2. Hover over elements on the page — they highlight in blue
3. Click an element to open the annotation popover
4. Describe what needs to change in the textarea
5. Click **Add** to queue the annotation, or **Send** to add + send everything to Funny immediately
6. Use **Ctrl+Click** to select multiple elements for a single annotation
7. The floating toolbar at the bottom provides additional controls (copy as markdown, settings, history)
