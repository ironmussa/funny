/** Element name, framework component and annotation data extraction. */

import {
  cssSelectorFull,
  formatAccessibility,
  formatStyles,
  getFullPath,
  getNearbyElements,
  getNearbyText,
} from '@funny/shared/dom/extract';

import { isString } from './dom';
import type { ElementData } from './types';

// Cache for component name lookups (WeakMap so GC can collect removed elements)
const componentNameCache = new WeakMap<Element, string>();
const componentTreeCache = new WeakMap<Element, string>();

// ---------------------------------------------------------------------------
// Element info extraction
// ---------------------------------------------------------------------------
export function getElementName(el: Element): string {
  // Try framework component name first (React, Vue, Angular, Svelte)
  const compName = getComponentName(el);
  if (compName) return compName;

  // Fallback: tag + class or id
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id}`;
  if (el.className && isString(el.className)) {
    const cls = el.className
      .split(/\s+/)
      .filter((c) => c && !c.startsWith('funny-'))
      .slice(0, 2)
      .join('.');
    if (cls) return `${tag}.${cls}`;
  }
  // Aria / role
  const role = el.getAttribute('role');
  if (role) return `${tag}[role="${role}"]`;
  // Use text content for small elements
  const text = el.textContent?.trim();
  if (text && text.length < 30 && text.length > 0) return `${tag} "${text.slice(0, 20)}"`;
  return tag;
}

// Framework component access via page-bridge.js (MAIN world).
// Content scripts can't see framework internals directly (isolated world).
// We communicate with page-bridge.js via CustomEvents + DOM attributes.
// Results are cached per-element in WeakMaps to avoid repeated DOM events.

function queryComponentInfo(el: Element) {
  // Single bridge call that populates both caches
  if (componentNameCache.has(el)) return;
  try {
    const uid = '__funny_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    el.setAttribute(uid, '');
    document.documentElement.setAttribute('data-funny-target', uid);
    document.dispatchEvent(new Event('__funny_get_component_info'));
    componentNameCache.set(el, el.getAttribute('data-funny-component') || '');
    componentTreeCache.set(el, el.getAttribute('data-funny-tree') || '');
    el.removeAttribute(uid);
    el.removeAttribute('data-funny-component');
    el.removeAttribute('data-funny-tree');
    document.documentElement.removeAttribute('data-funny-target');
  } catch {
    componentNameCache.set(el, '');
    componentTreeCache.set(el, '');
  }
}

function getComponentName(el: Element): string | null {
  queryComponentInfo(el);
  return componentNameCache.get(el) || null;
}

export function getComponentTree(el: Element): string {
  queryComponentInfo(el);
  return componentTreeCache.get(el) || '';
}

export function buildElementData(el: Element): ElementData {
  const rect = el.getBoundingClientRect();
  return {
    element: el.tagName.toLowerCase(),
    elementPath: cssSelectorFull(el, { excludeClassPrefix: 'funny-' }),
    elementName: getElementName(el),
    x: Math.round(((rect.left + rect.width / 2) / window.innerWidth) * 100 * 10) / 10,
    y: Math.round(rect.top + window.scrollY),
    boundingBox: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    componentTree: getComponentTree(el),
    cssClasses: (isString(el.className) ? el.className : '').trim(),
    computedStyles: formatStyles(el),
    accessibility: formatAccessibility(el),
    nearbyText: getNearbyText(el),
    isFixed: ['fixed', 'sticky'].includes(window.getComputedStyle(el).position),
    fullPath: getFullPath(el),
    nearbyElements: getNearbyElements(el),
    outerHTML: el.outerHTML.slice(0, 2000),
    domElement: el,
  };
}

// CSS selector, computed-style + accessibility formatters, nearby-text / path
// helpers live in `@funny/shared/dom/extract` — single source of truth shared
// with the in-app browser panel. See top-of-file imports.
