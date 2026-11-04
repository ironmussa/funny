/**
 * Regular-Chrome user agent for the runner's headless Chromium.
 *
 * Headless Chromium advertises `HeadlessChrome/<version>`, which many sites
 * (Cloudflare among them) treat as a bot signal. We launch with
 * `--user-agent=<value>` built here so every tab and worker reports
 * `Chrome/<major>.0.0.0` instead — the same reduced form real Chrome sends.
 * This is identity normalisation only, not fingerprint spoofing.
 */

const PLATFORM_TOKENS: Record<string, string> = {
  linux: 'X11; Linux x86_64',
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  win32: 'Windows NT 10.0; Win64; x64',
};

/** Extract the major version from `chrome --version` output ("Chromium 149.0.7827.0"). */
export function parseChromeMajor(versionOutput: string): number | null {
  const match = /(\d+)\.\d+\.\d+(?:\.\d+)?/.exec(versionOutput);
  return match ? Number.parseInt(match[1], 10) : null;
}

/** Build the reduced user agent real Chrome sends for a major version. */
export function regularChromeUserAgent(major: number, platform: string = process.platform): string {
  const token = PLATFORM_TOKENS[platform] ?? PLATFORM_TOKENS.linux;
  return `Mozilla/5.0 (${token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
