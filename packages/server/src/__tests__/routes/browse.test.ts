import { describe, test, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { homedir } from 'os';
import { readdirSync } from 'fs';

describe('Browse Routes', () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();

    // GET /roots
    app.get('/roots', (c) => {
      try {
        const drives: string[] = [];
        if (process.platform === 'win32') {
          for (let i = 65; i <= 90; i++) {
            const letter = String.fromCharCode(i);
            const drive = `${letter}:\\`;
            try {
              readdirSync(drive);
              drives.push(drive);
            } catch { /* skip */ }
          }
        } else {
          drives.push('/');
        }
        return c.json({ roots: drives, home: homedir() });
      } catch (error: any) {
        return c.json({ error: error.message }, 500);
      }
    });

    // GET /list
    app.get('/list', (c) => {
      const dirPath = c.req.query('path');
      if (!dirPath) {
        return c.json({ error: 'path query parameter required' }, 400);
      }
      try {
        const entries = readdirSync(dirPath, { withFileTypes: true });
        const dirs = entries
          .filter((e) => {
            if (!e.isDirectory()) return false;
            if (e.name.startsWith('.') || e.name === 'node_modules') return false;
            return true;
          })
          .map((e) => ({ name: e.name, path: `${dirPath}/${e.name}` }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return c.json({ path: dirPath, dirs });
      } catch (error: any) {
        return c.json({ error: error.message }, 500);
      }
    });
  });

  test('GET /roots returns drives/roots and home', async () => {
    const res = await app.request('/roots');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.roots).toBeTruthy();
    expect(Array.isArray(body.roots)).toBe(true);
    expect(body.roots.length).toBeGreaterThan(0);
    expect(body.home).toBe(homedir());
  });

  test('GET /list returns 400 when path is missing', async () => {
    const res = await app.request('/list');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('path');
  });

  test('GET /list returns directories for valid path', async () => {
    const res = await app.request(`/list?path=${encodeURIComponent(homedir())}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe(homedir());
    expect(Array.isArray(body.dirs)).toBe(true);
  });

  test('GET /list filters out hidden directories', async () => {
    const res = await app.request(`/list?path=${encodeURIComponent(homedir())}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const hiddenDirs = body.dirs.filter((d: any) => d.name.startsWith('.'));
    expect(hiddenDirs).toHaveLength(0);
  });

  test('GET /list filters out node_modules', async () => {
    const res = await app.request(`/list?path=${encodeURIComponent(homedir())}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const nm = body.dirs.filter((d: any) => d.name === 'node_modules');
    expect(nm).toHaveLength(0);
  });

  test('GET /list returns 500 for invalid path', async () => {
    const res = await app.request('/list?path=/this/path/does/not/exist/xyz');
    expect(res.status).toBe(500);
  });
});
