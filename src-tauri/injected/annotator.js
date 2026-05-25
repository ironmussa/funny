/* eslint-disable */
/**
 * funny Tauri Annotator — content script.
 *
 * Injected via `initialization_script` into the Tauri annotator webview.
 * Provides Chrome-extension-style hover/click annotation on ANY page,
 * regardless of origin — runs in the page's own document context.
 *
 * MVP scope:
 *   - hover → blue rectangle highlight + tooltip with tag/testid/class
 *   - click → captures element info, adds a numbered pin + entry
 *   - floating panel (top-right) shows captured entries + Copy + Clear + Stop
 *   - all UI lives inside a Shadow DOM to avoid bleeding host page styles
 *
 * Communication with the funny main window: v1 dumps markdown to the
 * clipboard. v2 will POST to the funny server (or use Tauri events) so the
 * annotation flows into a thread automatically.
 */
(() => {
  if (window.__funnyTauriAnnotatorActive) return;
  window.__funnyTauriAnnotatorActive = true;

  const HOST_ID = 'funny-annotator-host';
  const HL_COLOR = '#3b82f6'; // tailwind blue-500

  // --- Shadow root + styles ---------------------------------------------
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText =
    'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    .hl { position: fixed; pointer-events: none; border: 2px solid ${HL_COLOR}; background: ${HL_COLOR}1a; box-sizing: border-box; transition: all 60ms linear; }
    .label { position: fixed; pointer-events: none; background: ${HL_COLOR}; color: #fff; font: 12px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 2px 6px; border-radius: 4px; white-space: nowrap; max-width: 50vw; overflow: hidden; text-overflow: ellipsis; }
    .pin { position: absolute; pointer-events: auto; width: 22px; height: 22px; transform: translate(-50%, -50%); border-radius: 50%; background: ${HL_COLOR}; color: #fff; font: 600 11px/22px system-ui, sans-serif; text-align: center; border: 2px solid #fff; box-shadow: 0 1px 4px rgba(0,0,0,.4); cursor: pointer; }
    .panel { position: fixed; pointer-events: auto; top: 12px; right: 12px; width: 320px; max-height: 70vh; display: flex; flex-direction: column; background: #1f2937; color: #f9fafb; font: 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; border: 1px solid #374151; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.4); overflow: hidden; }
    .panel header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: #111827; border-bottom: 1px solid #374151; }
    .panel header strong { font-size: 13px; }
    .panel header .count { font-size: 11px; color: #9ca3af; }
    .panel ul { list-style: none; margin: 0; padding: 4px 0; overflow: auto; flex: 1; }
    .panel li { padding: 6px 12px; border-bottom: 1px solid #1f2937; display: flex; gap: 8px; align-items: flex-start; }
    .panel li:last-child { border-bottom: none; }
    .panel li .idx { color: ${HL_COLOR}; font-weight: 600; min-width: 18px; }
    .panel li .meta { flex: 1; min-width: 0; overflow: hidden; }
    .panel li .meta code { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; color: #d1d5db; word-break: break-all; }
    .panel li .meta input { width: 100%; margin-top: 4px; background: #111827; color: #f9fafb; border: 1px solid #374151; border-radius: 4px; padding: 4px 6px; font: 12px system-ui; }
    .panel li .del { background: transparent; color: #9ca3af; border: none; cursor: pointer; padding: 0 4px; font-size: 14px; }
    .panel li .del:hover { color: #ef4444; }
    .panel footer { display: flex; gap: 6px; padding: 8px; border-top: 1px solid #374151; background: #111827; }
    .panel button.action { flex: 1; background: ${HL_COLOR}; color: #fff; border: none; border-radius: 4px; padding: 6px 10px; font: 12px/1 system-ui; cursor: pointer; }
    .panel button.action.secondary { background: #374151; }
    .panel button.action:hover { filter: brightness(1.1); }
    .panel button.action:disabled { opacity: 0.5; cursor: not-allowed; }
    .crosshair { cursor: crosshair !important; }
  `;
  shadow.appendChild(style);

  // --- Elements ----------------------------------------------------------
  const hl = document.createElement('div');
  hl.className = 'hl';
  hl.style.display = 'none';

  const label = document.createElement('div');
  label.className = 'label';
  label.style.display = 'none';

  const pinsLayer = document.createElement('div');
  pinsLayer.style.cssText =
    'position: absolute; inset: 0; pointer-events: none;';
  // pinsLayer follows page scroll: positioned absolute relative to documentElement
  // (we'll convert client coords to page coords on capture).

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `
    <header>
      <strong>funny Annotator</strong>
      <span class="count" data-count>0 elements</span>
    </header>
    <ul data-list></ul>
    <footer>
      <button class="action" data-send>Send to funny</button>
      <button class="action secondary" data-copy>Copy</button>
      <button class="action secondary" data-clear>Clear</button>
      <button class="action secondary" data-stop>Stop</button>
    </footer>
  `;

  shadow.appendChild(hl);
  shadow.appendChild(label);
  shadow.appendChild(panel);

  // pinsLayer goes into a SEPARATE host on documentElement (not shadow) so
  // pins live in page-scroll coordinate space and follow scroll naturally.
  const pinsHost = document.createElement('div');
  pinsHost.id = 'funny-annotator-pins';
  pinsHost.style.cssText =
    'position: absolute; top: 0; left: 0; pointer-events: none; z-index: 2147483646;';
  pinsHost.appendChild(pinsLayer);

  const attach = () => {
    if (document.body) {
      document.body.appendChild(host);
      document.body.appendChild(pinsHost);
    } else {
      window.addEventListener('DOMContentLoaded', attach, { once: true });
    }
  };
  attach();

  // --- State -------------------------------------------------------------
  /** @type {{ id: string; index: number; pageX: number; pageY: number; tag: string; testid: string|null; classes: string[]; selector: string; text: string; note: string; }[]} */
  const captures = [];
  let counter = 0;
  let lastHoverEl = null;

  // --- Helpers -----------------------------------------------------------
  function cssSelectorFor(el) {
    if (!(el instanceof Element)) return '';
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 5) {
      let part = cur.tagName.toLowerCase();
      if (cur.getAttribute('data-testid')) {
        part += `[data-testid="${cur.getAttribute('data-testid')}"]`;
        parts.unshift(part);
        break;
      }
      const cls = (cur.getAttribute('class') || '')
        .trim()
        .split(/\s+/)
        .filter((c) => c && !/^[0-9]/.test(c) && c.length < 30)
        .slice(0, 2);
      if (cls.length) part += '.' + cls.map(CSS.escape).join('.');
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (s) => s.tagName === cur.tagName,
        );
        if (siblings.length > 1) {
          const idx = siblings.indexOf(cur) + 1;
          part += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const testid = el.getAttribute('data-testid');
    const cls = (el.getAttribute('class') || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3);
    return {
      tag,
      testid,
      classes: cls,
      selector: cssSelectorFor(el),
      text: (el.textContent || '').trim().slice(0, 80),
    };
  }

  function labelText(d) {
    let s = d.tag;
    if (d.testid) s += `[data-testid="${d.testid}"]`;
    else if (d.classes.length) s += '.' + d.classes.join('.');
    return s;
  }

  // --- Hover highlight ---------------------------------------------------
  function isAnnotatorEl(el) {
    while (el) {
      if (
        el.id === HOST_ID ||
        el.id === 'funny-annotator-pins' ||
        el === host ||
        el === pinsHost
      )
        return true;
      el = el.parentElement;
    }
    return false;
  }

  function onMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isAnnotatorEl(el)) {
      hl.style.display = 'none';
      label.style.display = 'none';
      lastHoverEl = null;
      return;
    }
    if (el === lastHoverEl) return;
    lastHoverEl = el;

    const r = el.getBoundingClientRect();
    hl.style.cssText += `; display: block; left: ${r.left}px; top: ${r.top}px; width: ${r.width}px; height: ${r.height}px;`;
    const d = describe(el);
    label.textContent = labelText(d);
    label.style.display = 'block';
    // Position label above the rect if there's room, else below.
    const labelTop = r.top > 24 ? r.top - 22 : r.bottom + 4;
    label.style.left = `${r.left}px`;
    label.style.top = `${labelTop}px`;
  }

  function onLeave() {
    hl.style.display = 'none';
    label.style.display = 'none';
    lastHoverEl = null;
  }

  // --- Click capture -----------------------------------------------------
  function onClick(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isAnnotatorEl(el)) return;
    // Suppress the page's own click. We're in annotator mode, not browse.
    e.preventDefault();
    e.stopPropagation();

    const r = el.getBoundingClientRect();
    const d = describe(el);
    const id = `c-${++counter}`;
    const entry = {
      id,
      index: counter,
      pageX: e.clientX + window.scrollX,
      pageY: e.clientY + window.scrollY,
      tag: d.tag,
      testid: d.testid,
      classes: d.classes,
      selector: d.selector,
      text: d.text,
      note: '',
    };
    captures.push(entry);

    // Render pin
    const pin = document.createElement('div');
    pin.className = 'pin';
    pin.dataset.id = id;
    pin.textContent = String(counter);
    pin.style.left = `${entry.pageX}px`;
    pin.style.top = `${entry.pageY}px`;
    pin.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const li = panel.querySelector(`[data-li="${id}"]`);
      if (li) {
        const input = li.querySelector('input');
        if (input) input.focus();
        li.scrollIntoView({ block: 'nearest' });
      }
    });
    pinsLayer.appendChild(pin);
    renderPanel();
  }

  // --- Panel UI ----------------------------------------------------------
  const list = panel.querySelector('[data-list]');
  const count = panel.querySelector('[data-count]');

  function renderPanel() {
    list.innerHTML = '';
    captures.forEach((c) => {
      const li = document.createElement('li');
      li.dataset.li = c.id;
      const head = labelText(c);
      li.innerHTML = `
        <span class="idx">${c.index}</span>
        <div class="meta">
          <code></code>
          <input type="text" placeholder="Note (optional)…" />
        </div>
        <button class="del" title="Remove">×</button>
      `;
      li.querySelector('code').textContent = head;
      const input = li.querySelector('input');
      input.value = c.note;
      input.addEventListener('input', () => {
        c.note = input.value;
      });
      li.querySelector('.del').addEventListener('click', () => {
        const idx = captures.findIndex((x) => x.id === c.id);
        if (idx >= 0) captures.splice(idx, 1);
        const pin = pinsLayer.querySelector(`[data-id="${c.id}"]`);
        if (pin) pin.remove();
        renderPanel();
      });
      list.appendChild(li);
    });
    count.textContent = `${captures.length} element${captures.length === 1 ? '' : 's'}`;
    panel.querySelector('[data-copy]').disabled = captures.length === 0;
    panel.querySelector('[data-clear]').disabled = captures.length === 0;
    panel.querySelector('[data-send]').disabled = captures.length === 0;
  }

  function buildMarkdown() {
    const url = window.location.href;
    const lines = [`# UI annotations — ${url}`, ''];
    captures.forEach((c) => {
      lines.push(`## ${c.index}. \`${labelText(c)}\``);
      lines.push('');
      lines.push(`- selector: \`${c.selector}\``);
      if (c.testid) lines.push(`- data-testid: \`${c.testid}\``);
      if (c.text) lines.push(`- text: ${JSON.stringify(c.text)}`);
      if (c.note) lines.push(`- note: ${c.note}`);
      lines.push('');
    });
    return lines.join('\n');
  }

  panel.querySelector('[data-copy]').addEventListener('click', async () => {
    const md = buildMarkdown();
    try {
      await navigator.clipboard.writeText(md);
      flash(panel.querySelector('[data-copy]'), 'Copied!');
    } catch {
      // Fallback: open a new window with the markdown selected.
      const w = window.open('', '_blank');
      if (w) {
        w.document.body.style.fontFamily = 'monospace';
        w.document.body.style.whiteSpace = 'pre-wrap';
        w.document.body.textContent = md;
      }
    }
  });

  // Send-to-funny: invokes the Tauri `annotator_send` command which re-emits
  // the payload as an event the main funny window listens for. On success
  // Rust closes this window so focus returns to funny.
  panel.querySelector('[data-send]').addEventListener('click', async () => {
    const btn = panel.querySelector('[data-send]');
    const md = buildMarkdown();
    const url = window.location.href;
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') {
      // Not running inside Tauri — degrade gracefully and copy instead.
      try {
        await navigator.clipboard.writeText(md);
        flash(btn, 'Copied (Tauri unavailable)');
      } catch {
        flash(btn, 'Failed');
      }
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      await internals.invoke('annotator_send', { markdown: md, url });
      // The Rust handler closes this window on success — we won't see Sent!
      // but set it anyway in case the close races with this UI update.
      flash(btn, 'Sent!');
    } catch (err) {
      console.error('[annotator] send failed', err);
      flash(btn, 'Failed');
      btn.disabled = false;
    }
  });

  panel.querySelector('[data-clear]').addEventListener('click', () => {
    captures.length = 0;
    pinsLayer.innerHTML = '';
    renderPanel();
  });

  panel.querySelector('[data-stop]').addEventListener('click', () => {
    stop();
  });

  function flash(btn, text) {
    const orig = btn.textContent;
    btn.textContent = text;
    setTimeout(() => {
      btn.textContent = orig;
    }, 1200);
  }

  // --- Activation --------------------------------------------------------
  // We listen on document with `capture: true` so we beat page handlers.
  // Move is throttled-via-rAF inside the function naturally (it's cheap).
  document.addEventListener('mousemove', onMove, { capture: true, passive: true });
  document.addEventListener('mouseleave', onLeave, { capture: true });
  document.addEventListener('click', onClick, { capture: true });

  function stop() {
    document.removeEventListener('mousemove', onMove, { capture: true });
    document.removeEventListener('mouseleave', onLeave, { capture: true });
    document.removeEventListener('click', onClick, { capture: true });
    host.remove();
    pinsHost.remove();
    window.__funnyTauriAnnotatorActive = false;
  }

  // Initial paint
  renderPanel();
  console.info('[funny annotator] active on', window.location.href);
})();
