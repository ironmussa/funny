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

The extension talks to funny's public REST API (`/api/v1`) and authenticates
only with a **personal API token** (`Authorization: Bearer funny_pat_…`).

### Connect to funny

1. In funny, open **Settings > API tokens**, create a token and copy it (it is shown once).
2. Open the extension's options page: right-click the extension icon > **Options**
   (or `chrome://extensions` > the extension > **Extension options**, or the **Set token**
   button in the toolbar's settings panel).
3. Enter the **Funny Server URL** (default `http://localhost:3001`) and paste the token
   in **API token** (use **Show** to check it).
4. Click **Save & test connection**. For a server other than `localhost:3001` /
   `127.0.0.1:3001`, Chrome asks for permission to reach that origin: allow it.
   If you deny it, the extension cannot reach the server (click the button again to retry).
   The in-page settings panel cannot ask for this permission; when it is missing it
   shows a button that opens the options page.

The token is kept in `chrome.storage.local` and is only shown in the options page,
never on the pages you annotate. If it expires or is revoked, the extension says
"The API token is invalid, expired or revoked": create a new one and paste it again.

### Thread settings

In the toolbar's settings panel (gear icon):

- **Server URL** — The Funny server address
- **Project** — Which Funny project to send annotations to (a project whose URL patterns
  match the page is picked automatically)
- **Provider / Model** — AI provider and model for the created thread (from `GET /api/v1/models`)
- **Mode** — `local` (work in project dir) or `worktree` (isolated branch)

Threads start in the `ask` permission mode: the public API refuses the modes that run
tools without asking (`autoEdit`, `auto`), so a stored value other than `ask`,
`confirmEdit` or `plan` is not sent.

## Manual test (against a local server)

1. `bun install` at the repo root, then `bun run dev:server` in your own terminal
   (funny on `http://localhost:3001`), and sign in to the web app.
2. Create a token in **Settings > API tokens**.
3. `cd packages/chrome-extension && bun run build`, then load the folder unpacked in
   `chrome://extensions` (or click reload on the extension card).
4. Open the extension options, enter `http://localhost:3001` and the token, click
   **Save & test connection**: the status says _Connected to Funny_ and the project,
   provider and model lists fill in.
5. Change one character of the token and test again: the status says the token is
   invalid. Put the right token back.
6. Open any web page, click the extension icon, pick a project in the toolbar's settings
   panel, annotate an element and click **Send**: the toast says _Sent to Funny! Thread
   created._ and the thread appears in funny, titled after the annotation, with the
   screenshot attached (its source is recorded as `chrome_extension`).
7. Open the toolbar's history and click the entry: the thread opens in funny.
8. Optional, remote server: set an `https://` server URL, click **Save & test connection**,
   allow the permission prompt, and send an annotation again.

## Usage

1. Click the extension icon
2. Hover over elements on the page — they highlight in blue
3. Click an element to open the annotation popover
4. Describe what needs to change in the textarea
5. Click **Add** to queue the annotation, or **Send** to add + send everything to Funny immediately
6. Use **Ctrl+Click** to select multiple elements for a single annotation
7. The floating toolbar at the bottom provides additional controls (copy as markdown, settings, history)
