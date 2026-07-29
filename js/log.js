'use strict';

const entries = [];
const MAX = 1500;
let outputEl = null, countEl = null;

function format(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function render() {
  if (outputEl) {
    outputEl.textContent = entries.slice(-400).join('\n');
    outputEl.scrollTop = outputEl.scrollHeight;
  }
  if (countEl) countEl.textContent = `${entries.length}`;
}

let pending = false;
function scheduleRender() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; render(); });
}

export function log(level, ...args) {
  const t = new Date().toISOString().slice(11, 23);
  entries.push(`${t} ${level.toUpperCase().padEnd(5)} ${args.map(format).join(' ')}`);
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
  scheduleRender();
}

export function attach(output, count) {
  outputEl = output; countEl = count; render();
}

export function captureConsole() {
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => { original(...args); log(level, ...args); };
  }
  window.addEventListener('error', e => log('error', 'window error', e.message, `${e.filename}:${e.lineno}:${e.colno}`));
  window.addEventListener('unhandledrejection', e => log('error', 'unhandled rejection', format(e.reason)));
}

export function dump() { return entries.join('\n'); }

export function clear() { entries.length = 0; render(); }

export async function copy() {
  const text = dump() || 'No entries.';
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}
