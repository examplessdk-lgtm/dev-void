/// <reference lib="dom" />
import type { HeadDescriptor } from './head';

const ATTR = 'data-void-head';

/**
 * Mark SSR-rendered head tags so they are cleaned up on the first SPA navigation.
 * Call once after hydration with the initial page's head descriptor.
 */
export function initClientHead(head: HeadDescriptor | undefined): void {
  if (!head) {
    return;
  }

  if (head.meta) {
    for (const entry of head.meta) {
      const selector = entry.charset
        ? 'meta[charset]'
        : entry.property
          ? `meta[property="${entry.property}"]`
          : entry.name
            ? `meta[name="${entry.name}"]`
            : null;
      if (!selector) {
        continue;
      }
      const el = document.head.querySelector(selector);
      if (el) {
        el.setAttribute(ATTR, '');
      }
    }
  }

  if (head.link) {
    for (const entry of head.link) {
      const el = document.head.querySelector(`link[rel="${entry.rel}"][href="${entry.href}"]`);
      if (el) {
        el.setAttribute(ATTR, '');
      }
    }
  }
}

/**
 * Apply head changes on SPA navigation.
 * Removes previously managed tags and inserts new ones.
 */
export function applyClientHead(head: HeadDescriptor | undefined): void {
  // Remove all previously managed tags
  for (const el of document.head.querySelectorAll(`[${ATTR}]`)) {
    el.remove();
  }

  if (!head) {
    return;
  }

  if (head.title !== undefined) {
    document.title = head.title;
  }

  if (head.meta) {
    for (const entry of head.meta) {
      const meta = document.createElement('meta');
      if (entry.charset) {
        meta.setAttribute('charset', entry.charset);
      }
      if (entry.name) {
        meta.setAttribute('name', entry.name);
      }
      if (entry.property) {
        meta.setAttribute('property', entry.property);
      }
      if (entry.content !== undefined) {
        meta.setAttribute('content', entry.content);
      }
      meta.setAttribute(ATTR, '');
      document.head.appendChild(meta);
    }
  }

  if (head.link) {
    for (const entry of head.link) {
      const link = document.createElement('link');
      for (const [key, value] of Object.entries(entry)) {
        if (value != null) {
          link.setAttribute(key, value);
        }
      }
      link.setAttribute(ATTR, '');
      document.head.appendChild(link);
    }
  }
}
