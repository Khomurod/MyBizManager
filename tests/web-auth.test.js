'use strict';

/**
 * Web authentication: passwords, sessions, roles and throttling.
 *
 * What this replaces is the point of most of these tests. The login page held
 * three username/password pairs in plain page source and then asked for
 * OMAD_ADMIN_KEY, which was the only thing the server checked — so the roles
 * were a choice of which page opened, every signed-in browser stored the key
 * that also unlocks migration and maintenance, and a café seller who edited two
 * localStorage values could read the ledger.
 *
 * So: the passwords are not in the frontend, the roles are refused on the
 * server, a session expires, changing a password ends the sessions it issued,
 * and wrong guesses are throttled per account rather than in one bucket that
 * every legitimate user shares.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadScript, readJsonOutput, postEvent } = require('./gas-harness');

const ROOT = path.join(__dirname, '..');
const ADMIN_KEY = 'maintenance-key-not-a-password';
const OWNER_PASSWORD = 'owner-password-1';
const SELLER_PASSWORD = 'seller-password-1';
const CAFE_ADMIN_PASSWORD = 'cafe-admin-password-1';

function boot() {
  return loadScript({
    properties: {
      OMAD_ADMIN_KEY: ADMIN_KEY,
      TELEGRAM_BOT_TOKEN: '123456789:AAFakeTokenForTestsOnly_0123456789abcd',
      TELEGRAM_AUTHORIZED_USER_ID: '49328655'
    },
    sheets: {
      System_Config: [
        ['Omad_Tenants', JSON.stringify([{ name: 'Apteka', defaultRent: 1000000, currency: 'UZS', active: true }])],
        ['Omad_Rates', JSON.stringify({ '2026-08': { buy: 12000, sell: 12500 } })],
        ['Cafe_Inventory', JSON.stringify([
          { id: 'i1', name: 'Kola', type: 'product', qty: 5, unit: 'dona', sellPrice: 8000, unitCost: 6000, totalCost: 30000 }
        ])]
      ],
      Cafe_Sales: [['Sana', 'Sotuvchi', 'Jami_Tushum', 'Sof_Foyda', 'Chek_Tafsilotlari', 'ID']]
    }
  });
}

function post(gas, body) {
  return readJsonOutput(gas.doPost(postEvent(body)));
}

/** A project with all three accounts provisioned, and their tokens. */
function bootProvisioned() {
  const gas = boot();
  const bootstrap = post(gas, { action: 'login', username: 'omad_admin', password: ADMIN_KEY });
  assert.strictEqual(bootstrap.status, 'success', 'the bootstrap sign-in works');

  [['cafe_admin', CAFE_ADMIN_PASSWORD], ['cafe_seller', SELLER_PASSWORD], ['omad_admin', OWNER_PASSWORD]]
    .forEach(([username, password]) => {
      const created = post(gas, {
        action: 'set_user_password', sessionToken: bootstrap.token,
        username, password, role: username
      });
      assert.strictEqual(created.status, 'success', `${username}: ${created.message}`);
    });

  const tokens = {};
  [['omad_admin', OWNER_PASSWORD], ['cafe_admin', CAFE_ADMIN_PASSWORD], ['cafe_seller', SELLER_PASSWORD]]
    .forEach(([username, password]) => {
      const signedIn = post(gas, { action: 'login', username, password });
      assert.strictEqual(signedIn.status, 'success', `${username} can sign in`);
      tokens[username] = signedIn.token;
    });

  return { gas, tokens };
}

// ------------------------------------------------------- credentials on disk

test('no password or password-equivalent secret is in the frontend source', () => {
  // The concrete regression: `USERS = { omad_admin: { password: "admin123" ...`
  // sat in login.html, and the page also asked the user to type OMAD_ADMIN_KEY.
  const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
  const assets = [];
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
    if (entry.isDirectory()) return walk(path.join(dir, entry.name));
    if (entry.name.endsWith('.js')) assets.push(path.join(dir, entry.name));
  });
  walk(path.join(ROOT, 'assets'));

  const files = pages.map(p => path.join(ROOT, p)).concat(assets);
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(ROOT, file);
    assert.ok(!/password\s*:\s*["'][^"']+["']/.test(source),
      `${relative} declares a literal password`);
    assert.ok(!/\b(admin123|seller123)\b/.test(source),
      `${relative} still contains one of the old shipped passwords`);
  }
});

test('the login page asks for a username and a password and nothing else', () => {
  const login = fs.readFileSync(path.join(ROOT, 'login.html'), 'utf8');
  assert.ok(/id="username"/.test(login) && /id="password"/.test(login));
  assert.ok(!/id="accessKey"/.test(login), 'the App Key field is gone');
  assert.ok(!/Kirish kaliti/.test(login), 'and so is its label');
  // The word survives in the comment explaining what was removed; what must
  // not survive is anywhere to type it.
  assert.ok(!/<input[^>]*(accessKey|adminKey)/i.test(login), 'there is no field for a key');
});

test('no page stores or sends the admin key as the ordinary credential', () => {
  for (const name of ['cafe_pos.html', 'cafe_admin.html', 'tasks.html']) {
    const source = fs.readFileSync(path.join(ROOT, name), 'utf8');
    assert.ok(!/omad_access_key/.test(source), `${name} still reads the stored admin key`);
  }
});

// -------------------------------------------------------------------- login

test('a correct username and password mints a session', () => {
  const { gas, tokens } = bootProvisioned();
  const verified = post(gas, { action: 'verify_access', sessionToken: tokens.cafe_seller });

  assert.strictEqual(verified.status, 'success');
  assert.strictEqual(verified.role, 'cafe_seller');
  assert.strictEqual(verified.home, 'cafe_pos.html', 'the server decides which page opens');
});

test('a wrong password is refused, and says nothing about which half was wrong', () => {
  const { gas } = bootProvisioned();
  const wrongPassword = post(gas, { action: 'login', username: 'cafe_seller', password: 'nope' });
  const unknownUser = post(gas, { action: 'login', username: 'nobody_here', password: 'nope' });

  assert.strictEqual(wrongPassword.status, 'error');
  assert.strictEqual(unknownUser.status, 'error');
  assert.strictEqual(wrongPassword.message, unknownUser.message,
    'an unknown account is indistinguishable from a wrong password');
  assert.ok(!JSON.stringify(wrongPassword).includes(SELLER_PASSWORD));
});

test('the stored credential is a salted hash, never the password', () => {
  const { gas } = bootProvisioned();
  const stored = gas.__properties.OMAD_USERS;

  assert.ok(stored, 'the user store exists');
  assert.ok(!stored.includes(OWNER_PASSWORD), 'no password is stored');
  assert.ok(!stored.includes(SELLER_PASSWORD));

  const users = JSON.parse(stored);
  assert.ok(users.cafe_seller.salt && users.cafe_seller.hash);
  assert.notStrictEqual(users.cafe_seller.salt, users.omad_admin.salt,
    'each account has its own salt, so one hash says nothing about another');
  assert.strictEqual(gas.hashPassword_(SELLER_PASSWORD, users.cafe_seller.salt), users.cafe_seller.hash);
});

test('a session token cannot be forged by editing its claims', () => {
  const { gas, tokens } = bootProvisioned();
  const parts = tokens.cafe_seller.split('.');
  // Same signature, "omad_admin" written into the role.
  parts[2] = 'omad_admin';
  const forged = parts.join('.');

  const refused = post(gas, { action: 'get_omad_data', sessionToken: forged });
  assert.strictEqual(refused.status, 'error');
  assert.strictEqual(refused.authExpired, true, 'a bad signature ends the session');
  assert.ok(!JSON.stringify(refused).includes('Apteka'));
});

test('an expired session is refused, and is told apart from a broken one', () => {
  const { gas } = bootProvisioned();
  const longAgo = Date.now() - (40 * 24 * 60 * 60 * 1000);
  const stale = gas.issueSessionToken_('cafe_seller', 'cafe_seller', 1, longAgo);

  const verified = gas.verifySessionToken_(stale.token);
  assert.strictEqual(verified.ok, false);
  assert.strictEqual(verified.reason, 'expired');

  const refused = post(gas, { action: 'get_cafe_data', sessionToken: stale.token });
  assert.strictEqual(refused.status, 'error');
  assert.strictEqual(refused.authExpired, true);
});

test('changing a password ends the sessions that password issued', () => {
  const { gas, tokens } = bootProvisioned();
  assert.strictEqual(post(gas, { action: 'verify_access', sessionToken: tokens.cafe_seller }).status, 'success');

  const changed = post(gas, {
    action: 'set_user_password', sessionToken: tokens.omad_admin,
    username: 'cafe_seller', password: 'a-brand-new-password', role: 'cafe_seller'
  });
  assert.strictEqual(changed.status, 'success');

  const afterwards = post(gas, { action: 'verify_access', sessionToken: tokens.cafe_seller });
  assert.strictEqual(afterwards.status, 'error', 'the old token is dead');
  assert.strictEqual(afterwards.authExpired, true);

  const reissued = post(gas, { action: 'login', username: 'cafe_seller', password: 'a-brand-new-password' });
  assert.strictEqual(reissued.status, 'success');
});

test('a user may change their own password and keeps working afterwards', () => {
  const { gas, tokens } = bootProvisioned();
  const wrongCurrent = post(gas, {
    action: 'change_password', sessionToken: tokens.cafe_admin,
    currentPassword: 'not-it', newPassword: 'another-password-2'
  });
  assert.strictEqual(wrongCurrent.status, 'error');

  const changed = post(gas, {
    action: 'change_password', sessionToken: tokens.cafe_admin,
    currentPassword: CAFE_ADMIN_PASSWORD, newPassword: 'another-password-2'
  });
  assert.strictEqual(changed.status, 'success');
  assert.ok(changed.token, 'a replacement session comes back, so nobody is signed out mid-task');
  assert.strictEqual(post(gas, { action: 'verify_access', sessionToken: changed.token }).status, 'success');
  assert.strictEqual(post(gas, { action: 'verify_access', sessionToken: tokens.cafe_admin }).status, 'error');
});

test('a password below the minimum length is refused', () => {
  const { gas, tokens } = bootProvisioned();
  const refused = post(gas, {
    action: 'set_user_password', sessionToken: tokens.omad_admin,
    username: 'cafe_seller', password: 'short', role: 'cafe_seller'
  });
  assert.strictEqual(refused.status, 'error');
});

// --------------------------------------------------------------------- roles

test('a café seller cannot reach anything outside the till', () => {
  const { gas, tokens } = bootProvisioned();
  const forbidden = [
    { action: 'get_omad_data' },
    { action: 'list_transactions' },
    { action: 'create_transaction' },
    { action: 'save_omad', transactions: [], tenants: [], rates: {}, templateExpenses: [] },
    { action: 'get_tasks' },
    { action: 'save_task', type: 'once', title: 'x' },
    { action: 'get_system_status' },
    { action: 'get_telegram_settings' },
    { action: 'save_telegram_settings', authorizedUserId: '1', groupChatId: '-100' },
    { action: 'get_migration_status' },
    { action: 'apply_omad_migration' },
    { action: 'rollback_omad_migration' },
    { action: 'audit_transaction_dates' },
    { action: 'rotate_telegram_webhook_secret' },
    { action: 'create_backup' },
    { action: 'get_health' },
    { action: 'list_users' },
    { action: 'set_user_password', username: 'omad_admin', password: 'hijacked-password', role: 'omad_admin' },
    // The catalogue is the manager's half of the café, not the till's.
    { action: 'save_inventory', inventory: [] },
    { action: 'save_recipe', recipes: [] },
    { action: 'save_categories', categories: [] },
    { action: 'save_cafe_settings', settings: {} }
  ];

  forbidden.forEach(payload => {
    const answer = post(gas, Object.assign({ sessionToken: tokens.cafe_seller }, payload));
    assert.strictEqual(answer.status, 'error', `${payload.action} answered a café seller`);
    assert.ok(!JSON.stringify(answer).includes('Apteka'), `${payload.action} leaked a tenant name`);
  });

  // ...and nothing was written by any of it.
  assert.strictEqual(post(gas, { action: 'login', username: 'omad_admin', password: 'hijacked-password' }).status,
    'error', 'the refused password change did not happen');
});

test('a café seller can do the till, and only the till', () => {
  const { gas, tokens } = bootProvisioned();

  const read = post(gas, { action: 'get_cafe_data', scope: 'pos', sessionToken: tokens.cafe_seller });
  assert.strictEqual(read.status, 'success');
  assert.strictEqual(read.inventory.length, 1);

  const sold = post(gas, {
    action: 'save_sale', sessionToken: tokens.cafe_seller,
    requestId: 'req_role_1', id: 'sale_role_1', date: '2026-08-13T09:00:00.000Z', seller: 'kassir',
    items: [{ kind: 'product', inventoryId: 'i1', qty: 1 }]
  });
  assert.strictEqual(sold.status, 'success');
  assert.strictEqual(post(gas, { action: 'void_sale', id: 'sale_role_1', sessionToken: tokens.cafe_seller }).status, 'success');
});

test('a café manager edits the catalogue but does not ring up sales', () => {
  const { gas, tokens } = bootProvisioned();

  assert.strictEqual(post(gas, {
    action: 'save_categories', categories: ['Ichimliklar'], sessionToken: tokens.cafe_admin
  }).status, 'success');

  const refused = post(gas, {
    action: 'save_sale', sessionToken: tokens.cafe_admin,
    requestId: 'req_role_2', id: 'sale_role_2', date: '2026-08-13T09:00:00.000Z', seller: 'boshqaruv',
    items: [{ kind: 'product', inventoryId: 'i1', qty: 1 }]
  });
  assert.strictEqual(refused.status, 'error');
  assert.strictEqual(post(gas, { action: 'get_omad_data', sessionToken: tokens.cafe_admin }).status, 'error');
});

test('the owner can do everything all three roles can', () => {
  const { gas, tokens } = bootProvisioned();
  assert.strictEqual(post(gas, { action: 'get_omad_data', sessionToken: tokens.omad_admin }).status, 'success');
  assert.strictEqual(post(gas, { action: 'get_cafe_data', sessionToken: tokens.omad_admin }).status, 'success');
  assert.strictEqual(post(gas, { action: 'get_tasks', sessionToken: tokens.omad_admin }).status, 'success');
  assert.strictEqual(post(gas, {
    action: 'save_categories', categories: ['Ichimliklar'], sessionToken: tokens.omad_admin
  }).status, 'success');
});

test('a refusal for the wrong role is not an expired session', () => {
  const { gas, tokens } = bootProvisioned();
  const refused = post(gas, { action: 'get_omad_data', sessionToken: tokens.cafe_seller });

  // The client signs out on authExpired and only on authExpired. A seller who
  // has wandered on to the wrong page must not be told their session is over.
  assert.strictEqual(refused.code, 'forbidden');
  assert.strictEqual(refused.authExpired, false);
});

// ---------------------------------------------------------------- throttling

test('repeated wrong passwords for one account are throttled', () => {
  const { gas } = bootProvisioned();
  let throttled = null;
  for (let i = 0; i < gas.LOGIN_FAILURE_LIMIT_PER_USER + 2; i++) {
    throttled = post(gas, { action: 'login', username: 'cafe_seller', password: `guess-${i}` });
  }
  assert.strictEqual(throttled.code, 'throttled', 'guessing costs the guesser the account');

  // Even the right password waits, which is the point of the throttle...
  assert.strictEqual(post(gas, { action: 'login', username: 'cafe_seller', password: SELLER_PASSWORD }).code,
    'throttled');
  // ...but only for that account. Guessing at the till must not lock the owner
  // out of the accounting, which one shared bucket would do.
  assert.strictEqual(post(gas, { action: 'login', username: 'omad_admin', password: OWNER_PASSWORD }).status,
    'success');
});

test('a signed-in user is never throttled by somebody else failing', () => {
  const { gas, tokens } = bootProvisioned();

  // Forty forged tokens and forty wrong keys: comfortably past every failure
  // allowance there is.
  for (let i = 0; i < 40; i++) {
    post(gas, { action: 'get_cafe_data', sessionToken: `v1.attacker.omad_admin.9999999999.1.n${i}.deadbeef` });
    post(gas, { action: 'get_cafe_data', adminKey: `guess-${i}` });
  }

  const seller = post(gas, { action: 'get_cafe_data', scope: 'pos', sessionToken: tokens.cafe_seller });
  assert.strictEqual(seller.status, 'success', 'the till keeps working through all of it');
  assert.strictEqual(post(gas, { action: 'get_omad_data', sessionToken: tokens.omad_admin }).status, 'success');
});

test('a wrong admin key still exhausts its own strict allowance', () => {
  const gas = boot();
  let refusals = 0;
  for (let i = 0; i < 12; i++) {
    if (post(gas, { action: 'get_omad_data', adminKey: `guess-${i}` }).status === 'error') refusals++;
  }
  assert.strictEqual(refusals, 12);

  // Past the limit even the correct key waits: guessing costs the guesser the
  // endpoint. This is the property the 40-per-minute hotfix gave away.
  const correct = post(gas, { action: 'get_omad_data', adminKey: ADMIN_KEY });
  assert.strictEqual(correct.status, 'error');
  assert.strictEqual(correct.code, 'throttled');
});

test('one till does not spend another user\'s request allowance', () => {
  const { gas, tokens } = bootProvisioned();
  let sellerRefusals = 0;
  for (let i = 0; i < gas.AUTHENTICATED_REQUEST_LIMIT + 5; i++) {
    if (post(gas, { action: 'get_cafe_data', scope: 'pos', sessionToken: tokens.cafe_seller }).status === 'error') {
      sellerRefusals++;
    }
  }
  assert.ok(sellerRefusals > 0, 'a single client can still be throttled');
  assert.strictEqual(post(gas, { action: 'get_cafe_data', sessionToken: tokens.cafe_admin }).status, 'success',
    'the manager is unaffected');
});

test('no rate-limit bucket key contains a credential', () => {
  const { gas, tokens } = bootProvisioned();
  post(gas, { action: 'get_cafe_data', sessionToken: tokens.cafe_seller });
  post(gas, { action: 'get_omad_data', adminKey: 'a-wrong-key-value' });
  post(gas, { action: 'login', username: 'cafe_seller', password: 'a-wrong-password' });

  const keys = Object.keys(gas.__cache);
  assert.ok(keys.length > 0, 'something was counted');
  keys.forEach(key => {
    assert.ok(!key.includes(ADMIN_KEY), `${key} contains the admin key`);
    assert.ok(!key.includes(SELLER_PASSWORD), `${key} contains a password`);
    assert.ok(!key.includes('a-wrong-key-value'), `${key} contains an attempted key`);
    assert.ok(!key.includes('a-wrong-password'), `${key} contains an attempted password`);
    assert.ok(!key.includes(tokens.cafe_seller), `${key} contains a session token`);
  });
});

// ------------------------------------------------------------------ bootstrap

test('the maintenance key signs the owner in only until they set a password', () => {
  const gas = boot();
  const first = post(gas, { action: 'login', username: 'omad_admin', password: ADMIN_KEY });
  assert.strictEqual(first.status, 'success');
  assert.strictEqual(first.bootstrap, true, 'and says so, so the UI can insist');

  // It is not a way in as anybody else.
  assert.strictEqual(post(gas, { action: 'login', username: 'cafe_seller', password: ADMIN_KEY }).status, 'error');

  post(gas, {
    action: 'set_user_password', sessionToken: first.token,
    username: 'omad_admin', password: OWNER_PASSWORD, role: 'omad_admin'
  });

  assert.strictEqual(post(gas, { action: 'login', username: 'omad_admin', password: ADMIN_KEY }).status, 'error',
    'the maintenance key stops being a password the moment there is a real one');
  assert.strictEqual(post(gas, { action: 'verify_access', sessionToken: first.token }).status, 'error',
    'and the bootstrap session ends with it');
});

test('the admin key still authorizes maintenance, as omad_admin', () => {
  const { gas } = bootProvisioned();
  assert.strictEqual(post(gas, { action: 'get_migration_status', adminKey: ADMIN_KEY }).status, 'success');
  assert.strictEqual(post(gas, { action: 'get_omad_data', adminKey: ADMIN_KEY }).status, 'success');
});

test('the Mini App gate is untouched by any of this', () => {
  const { gas, tokens } = bootProvisioned();

  // A web session is not a Mini App credential...
  const withSession = post(gas, { action: 'mini_home', sessionToken: tokens.omad_admin, period: '2026-08' });
  assert.strictEqual(withSession.authorized, false);

  // ...and neither is the admin key, which is the rule the Mini App has always
  // had: verified Telegram initData, or nothing.
  const withKey = post(gas, { action: 'mini_home', adminKey: ADMIN_KEY, period: '2026-08' });
  assert.strictEqual(withKey.authorized, false);
  assert.ok(!JSON.stringify(withKey).includes('Apteka'));
});
