import { defineConfig } from 'vitepress';

// VitePress config for the funny documentation site.
// Source lives in ./docs; `index.md` is the home page and `README.md`
// stays as the plain-text index for GitHub browsing.
export default defineConfig({
  title: 'funny',
  description: 'Parallel Claude Code agent orchestration with git worktrees',
  lastUpdated: true,
  cleanUrls: true,

  // GitHub Pages serves a project repo under /<repo>/. Set base accordingly.
  // Change to '/' if you later move docs to a custom domain or org/user page.
  base: '/funny/',

  // README.md is the GitHub-facing index; the site uses index.md instead.
  srcExclude: ['README.md'],

  // Some docs link to source files in the repo (packages/, examples/) that
  // are meant to be read on GitHub, not as site pages. Don't fail on those.
  ignoreDeadLinks: [/\/packages\//, /\/examples\//],

  // The repo pins esbuild >=0.24 (see root package.json `resolutions`), which
  // refuses to downtranspile destructuring to VitePress's default browser
  // targets. The docs site only needs modern browsers, so target esnext.
  vite: {
    build: { target: 'esnext' },
  },

  themeConfig: {
    nav: [
      { text: 'Guides', link: '/guides/ingest-api' },
      { text: 'Architecture', link: '/architecture/pipeline' },
      { text: 'RFCs', link: '/rfc/route-driven-threads' },
      {
        text: 'Repo',
        items: [
          { text: 'README', link: 'https://github.com/ironmussa/funny#readme' },
          { text: 'INSTALL', link: 'https://github.com/ironmussa/funny/blob/master/INSTALL.md' },
        ],
      },
    ],

    sidebar: [
      {
        text: 'Guides',
        collapsed: false,
        items: [
          { text: 'Ingest API', link: '/guides/ingest-api' },
          { text: 'Process cleanup', link: '/guides/process-cleanup' },
          { text: 'Visualizer plugins', link: '/visualizer-plugins' },
        ],
      },
      {
        text: 'Architecture',
        collapsed: false,
        items: [
          { text: 'Pipeline', link: '/architecture/pipeline' },
          { text: 'Process execution strategy', link: '/architecture/process-execution-strategy' },
        ],
      },
      {
        text: 'Design',
        collapsed: true,
        items: [{ text: 'Browser panel screenshot', link: '/design/browser-panel-screenshot' }],
      },
      {
        text: 'RFCs',
        collapsed: true,
        items: [{ text: 'Route-driven threads', link: '/rfc/route-driven-threads' }],
      },
      {
        text: 'Plans',
        collapsed: true,
        items: [
          { text: 'Overview', link: '/plans/README' },
          { text: 'Observability', link: '/plans/observability' },
        ],
      },
      {
        text: 'Reports',
        collapsed: true,
        items: [
          { text: 'Architecture evaluation', link: '/reports/2026-04-23-architecture-evaluation' },
          { text: 'Security regression gaps', link: '/reports/security-regression-gaps' },
        ],
      },
    ],

    search: {
      provider: 'local',
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/ironmussa/funny' }],

    editLink: {
      pattern: 'https://github.com/ironmussa/funny/edit/master/docs/:path',
      text: 'Edit this page on GitHub',
    },
  },
});
