'use strict';

/**
 * Functional parity of the web pages: nothing a person could reach may
 * disappear by accident.
 *
 * tests/fixtures/ui-parity-baseline.json is the inventory taken before the
 * 2026-11 redesign: for every page, every element id its markup and its own
 * scripts create, and every function a control calls (onclick, onchange,
 * oninput, onsubmit, onkeydown). A redesign may move, restyle and regroup all
 * of it; it may not lose any of it. Removing something on purpose means
 * removing it from the baseline in the same change, where a reviewer sees it.
 *
 * Also checked here: every id a page's scripts look up with getElementById
 * exists somewhere in that page or its scripts. A renamed id breaks its
 * handler silently -- the button still renders and does nothing. And every
 * Lucide icon a page names must be in assets/icons/lucide.svg, or it renders
 * as an empty square.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASELINE = require('./fixtures/ui-parity-baseline.json');

/** A page's markup plus every script it loads from this repository. */
function pageSource(page) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]).filter(src => src.startsWith('assets/'));
  const js = scripts.map(src => fs.readFileSync(path.join(ROOT, src), 'utf8')).join('\n');
  const inline = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
  return { html, js, inline, all: html + '\n' + js };
}

function inventory(page) {
  const { js, inline, all } = pageSource(page);
  return {
    ids: new Set([...all.matchAll(/\bid="([^"$]+)"/g)].map(m => m[1])),
    // An inline `if (...)` guard is not a function a control calls.
    handlers: new Set([...all.matchAll(/on(?:click|change|input|submit|keydown|keyup)="([a-zA-Z_$][\w$]*)\(/g)]
      .map(m => m[1]).filter(name => name !== 'if')),
    referenced: new Set([...(js + inline).matchAll(/getElementById\(\s*['"`]([^'"`$]+)['"`]\s*\)/g)].map(m => m[1])),
    functions: new Set([...all.matchAll(/(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:^|\n)\s*([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b)/g)]
      .map(m => m[1] || m[2]))
  };
}

for (const page of Object.keys(BASELINE)) {
  test(`${page}: every element id from before the redesign still exists`, () => {
    const now = inventory(page);
    const lost = BASELINE[page].ids.filter(id => !now.ids.has(id));
    assert.deepStrictEqual(lost, [], `${page} lost: ${lost.join(', ')}`);
  });

  test(`${page}: every action a control called is still called by one`, () => {
    const now = inventory(page);
    const lost = BASELINE[page].handlers.filter(name => !now.handlers.has(name));
    assert.deepStrictEqual(lost, [], `${page} no longer wires: ${lost.join(', ')}`);
  });

  test(`${page}: every control calls a function that exists`, () => {
    const now = inventory(page);
    const missing = [...now.handlers].filter(name => !now.functions.has(name));
    assert.deepStrictEqual(missing, [], `${page} calls undefined: ${missing.join(', ')}`);
  });

  test(`${page}: every id its scripts look up is defined`, () => {
    const now = inventory(page);
    const missing = [...now.referenced].filter(id => !now.ids.has(id));
    assert.deepStrictEqual(missing, [], `${page} looks up missing ids: ${missing.join(', ')}`);
  });
}

test('every icon a page names is in the committed sprite', () => {
  const result = require('child_process').spawnSync(process.execPath,
    [path.join(ROOT, 'scripts', 'build-icons.js'), '--check'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
});

test('no page loads Font Awesome or another icon font any more', () => {
  const pages = Object.keys(BASELINE);
  const loading = pages.filter(page => /font-awesome|fontawesome|class="fa[srb]? fa-/i.test(pageSource(page).all));
  assert.deepStrictEqual(loading, []);
});
