#!/usr/bin/env node
'use strict';

/**
 * Standalone secret scanner.
 *
 *   node scripts/scan-secrets.js            scan the working tree
 *   node scripts/scan-secrets.js --history  also scan every committed blob
 *
 * Exits non-zero when a Telegram-bot-token-shaped string is found.
 * History findings are reported as warnings by default because rewriting
 * published history is a deliberate, destructive operation - set
 * FAIL_ON_HISTORY=1 to make them fail the build once history has been cleaned.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TOKEN_PATTERN = /\b\d{6,16}:[A-Za-z0-9_-]{30,}\b/g;
const SCANNED_EXTENSIONS = ['.html', '.gs', '.js', '.md', '.json', '.yml', '.yaml', '.csv', '.txt'];
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);
// The test suite deliberately uses one obviously fake fixture token. It is
// allowlisted by exact value (not by path), so a real secret committed into
// tests/ is still caught.
const FIXTURE_TOKENS = new Set([
  '123456789:AAFakeTokenForTestsOnly_0123456789abcd'
]);

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), files);
    } else if (SCANNED_EXTENSIONS.includes(path.extname(entry.name))) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

function mask(token) {
  return `${token.slice(0, 4)}…${token.slice(-4)} (${token.length} chars)`;
}

function scanWorkingTree() {
  const findings = [];
  for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const matches = line.match(TOKEN_PATTERN) || [];
      matches
        .filter(m => !FIXTURE_TOKENS.has(m))
        .forEach(m => findings.push(`${rel}:${i + 1}: ${mask(m)}`));
    });
  }
  return findings;
}

function scanHistory() {
  const findings = [];
  let revisions;
  try {
    revisions = execFileSync('git', ['rev-list', '--all'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch (error) {
    return findings;
  }

  const seen = new Set();
  for (const rev of revisions) {
    let listing;
    try {
      listing = execFileSync('git', ['ls-tree', '-r', rev], { cwd: ROOT, encoding: 'utf8' });
    } catch (error) {
      continue;
    }
    for (const line of listing.split('\n')) {
      const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
      if (!match) continue;
      const [, blob, file] = match;
      if (!SCANNED_EXTENSIONS.includes(path.extname(file))) continue;
      if (seen.has(blob)) continue;
      seen.add(blob);

      let content;
      try {
        content = execFileSync('git', ['cat-file', 'blob', blob], { cwd: ROOT, encoding: 'utf8' });
      } catch (error) {
        continue;
      }
      const hits = (content.match(TOKEN_PATTERN) || []).filter(m => !FIXTURE_TOKENS.has(m));
      if (hits.length > 0) findings.push(`${rev.slice(0, 8)} ${file}: ${mask(hits[0])}`);
    }
  }
  return findings;
}

const scanHistoryToo = process.argv.includes('--history');
const workingTreeFindings = scanWorkingTree();

if (workingTreeFindings.length > 0) {
  console.error('Secret scan FAILED - Telegram token-shaped values in the working tree:');
  workingTreeFindings.forEach(f => console.error(`  ${f}`));
  process.exit(1);
}
console.log('Secret scan: working tree clean.');

if (scanHistoryToo) {
  const historyFindings = scanHistory();
  if (historyFindings.length > 0) {
    const failOnHistory = process.env.FAIL_ON_HISTORY === '1';
    const label = failOnHistory ? 'FAILED' : 'WARNING';
    console[failOnHistory ? 'error' : 'warn'](
      `Secret scan ${label} - token-shaped values remain in git history (${historyFindings.length} blob(s)).`
    );
    historyFindings.slice(0, 20).forEach(f => console.warn(`  ${f}`));
    console.warn('  These commits are already published. Revoke the token via BotFather;');
    console.warn('  see docs/TELEGRAM_SETUP.md for the history-rewrite procedure.');
    if (failOnHistory) process.exit(1);
  } else {
    console.log('Secret scan: git history clean.');
  }
}
