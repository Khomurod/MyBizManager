// ============================================================
// Web authentication: users, passwords, sessions and roles
// ------------------------------------------------------------
// The login page used to hold three username/password pairs in plain page
// source and then ask for OMAD_ADMIN_KEY as the thing the server actually
// checked. So the passwords were decoration, the real credential was typed by
// hand into a phone at every sign-in, and every signed-in browser held the one
// key that also unlocks migration and maintenance.
//
// This module replaces all of that:
//
//   * Credentials live in the OMAD_USERS Script Property, as a salted,
//     iterated hash per user. No password, and nothing derived from one that
//     could be replayed, is ever sent to a browser or committed to the repo.
//   * A successful login mints a signed, expiring session token. It is a MAC
//     over the claims, so verifying one is a hash rather than a sheet read and
//     losing the cache or restarting the project cannot sign anybody out.
//   * Every action names the roles that may perform it. A café seller editing
//     localStorage, or opening omad_admin.html directly, still cannot read the
//     ledger — the refusal is on the server, where the browser cannot reach it.
//
// OMAD_ADMIN_KEY survives as an internal break-glass credential for
// maintenance and migration, and is accepted as omad_admin wherever a session
// would be. Nobody has to know it to use the application.
// ============================================================

/** Salted password hashes, as JSON: { username: { role, salt, hash, pwv } }. */
var OMAD_PROP_USERS = "OMAD_USERS";

/** HMAC key the session tokens are signed with. Generated on first use. */
var OMAD_PROP_SESSION_SECRET = "OMAD_SESSION_SECRET";

var AUTH_ROLE_OMAD_ADMIN = "omad_admin";
var AUTH_ROLE_CAFE_ADMIN = "cafe_admin";
var AUTH_ROLE_CAFE_SELLER = "cafe_seller";

/** The only roles that exist. A stored record naming anything else is ignored. */
var AUTH_VALID_ROLES = {
  omad_admin: true,
  cafe_admin: true,
  cafe_seller: true
};

/** Which page each role signs in to. The server decides, not the page. */
var AUTH_ROLE_HOME = {
  omad_admin: "omad_admin.html",
  cafe_admin: "cafe_admin.html",
  cafe_seller: "cafe_pos.html"
};

/**
 * Password hashing: HMAC-SHA256 chained over a per-user salt.
 *
 * Apps Script has no PBKDF2, and `Utilities.computeHmacSha256Signature` is the
 * only primitive available in both the runtime and the test harness. Chaining
 * it is a plain iterated KDF: it makes an offline guess cost the same as a
 * login instead of a single hash, which is the property that matters when the
 * stored value is a Script Property only the project owner can read.
 *
 * The count is a compromise. Sign-in happens once per session and a session
 * lasts a month, so a few hundred milliseconds there is invisible; the same
 * cost is charged to every wrong guess, on top of the throttle below.
 */
var AUTH_HASH_ITERATIONS = 200;

/** A month. Long enough that nobody is asked to sign in repeatedly. */
var AUTH_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Usernames are part of the token's own delimiter-separated format. */
var AUTH_USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/;

var AUTH_MIN_PASSWORD_LENGTH = 8;

var AUTH_MAX_PASSWORD_LENGTH = 200;

var AUTH_TOKEN_VERSION = "v1";

// ---------------------------------------------------------------- throttling
//
// Three buckets, deliberately not one:
//
//   * per username, strict — the only thing that stops somebody working
//     through a password list against a known account, and it can only be
//     filled by failures *against that account*;
//   * all failed logins, generous — blunts spraying across many usernames
//     without letting one attacker lock out the whole business at ten
//     attempts;
//   * failed authentication on ordinary requests, strict — a wrong or missing
//     admin key, or a forged token.
//
// A *successful* request never touches any of them. That is the fix for the
// incident this replaced: the café till shared one 40-per-minute bucket with
// every failed attempt in the world, so a second tab could throttle the shop.

var LOGIN_FAILURE_LIMIT_PER_USER = 8;

var LOGIN_FAILURE_LIMIT_GLOBAL = 100;

var AUTH_FAILURE_LIMIT = 10;

/**
 * Per-signed-in-user request allowance.
 *
 * Keyed by username — which is not a secret, so no credential ever appears in
 * a cache key — so one busy till cannot throttle the office, and neither can
 * an anonymous stranger throttle either of them.
 */
var AUTHENTICATED_REQUEST_LIMIT = 120;

// --------------------------------------------------------------- user records

function readAuthUsers_() {
  var stored = safeParseJSON_(getTelegramSetting_(OMAD_PROP_USERS), null);
  return stored && typeof stored === "object" ? stored : {};
}

function writeAuthUsers_(users) {
  setTelegramSetting_(OMAD_PROP_USERS, JSON.stringify(users || {}));
}

/**
 * True once the owner's own account has a password.
 *
 * This, not "any user exists", is what ends the bootstrap: setting the café
 * passwords is the first thing the bootstrap session is *for*, so it must not
 * be the thing that invalidates it half way through.
 */
function omadAdminAccountConfigured_() {
  return !!readAuthUsers_()[AUTH_ROLE_OMAD_ADMIN];
}

function normalizeUsername_(value) {
  return String(value === null || value === undefined ? "" : value).trim().toLowerCase();
}

/** 64 hex characters of salt, from two UUIDs. */
function newAuthSalt_() {
  return (Utilities.getUuid() + Utilities.getUuid()).split("-").join("");
}

/**
 * The stored form of one password.
 *
 * Returns hex. The first round takes the password as the message so the salt
 * is the key; every later round feeds the digest back as the message, so the
 * whole chain has to be walked to check one guess.
 */
function hashPassword_(password, salt) {
  var saltBytes = Utilities.newBlob(String(salt)).getBytes();
  var digest = Utilities.computeHmacSha256Signature(String(password), String(salt));
  for (var i = 1; i < AUTH_HASH_ITERATIONS; i++) {
    digest = Utilities.computeHmacSha256Signature(digest, saltBytes);
  }
  return bytesToHex_(digest);
}

function validatePasswordStrength_(password) {
  var value = String(password === null || password === undefined ? "" : password);
  if (value.length < AUTH_MIN_PASSWORD_LENGTH) {
    return "Parol kamida " + AUTH_MIN_PASSWORD_LENGTH + " ta belgidan iborat bo'lishi kerak.";
  }
  if (value.length > AUTH_MAX_PASSWORD_LENGTH) return "Parol juda uzun.";
  return "";
}

/**
 * Creates or replaces one user's credential.
 *
 * `pwv` is a password version carried inside every token. Changing a password
 * bumps it, which invalidates every session that user already had — the only
 * revocation mechanism a stateless token needs, and the one thing a change of
 * password is expected to do.
 */
function setUserCredential_(username, password, role) {
  var name = normalizeUsername_(username);
  if (!AUTH_USERNAME_PATTERN.test(name)) {
    return { status: "error", message: "Foydalanuvchi nomi faqat kichik harf, raqam va _ bo'lishi mumkin (3-32 belgi)." };
  }

  var users = readAuthUsers_();
  var existing = users[name] || null;
  var nextRole = role === undefined || role === null || role === "" ? (existing && existing.role) : String(role);
  if (!AUTH_VALID_ROLES[nextRole]) {
    return { status: "error", message: "Rol noto'g'ri. Ruxsat etilgan rollar: omad_admin, cafe_admin, cafe_seller." };
  }

  var weak = validatePasswordStrength_(password);
  if (weak) return { status: "error", message: weak };

  var salt = newAuthSalt_();
  users[name] = {
    role: nextRole,
    salt: salt,
    hash: hashPassword_(password, salt),
    pwv: (Number(existing && existing.pwv) || 0) + 1,
    updatedAt: new Date().toISOString()
  };
  writeAuthUsers_(users);

  return { status: "success", username: name, role: nextRole, created: !existing };
}

/**
 * Checks a username and password against the stored record.
 *
 * A missing user and a wrong password answer identically, so the endpoint
 * cannot be used to find out which accounts exist.
 */
function verifyUserPassword_(username, password) {
  var name = normalizeUsername_(username);
  var users = readAuthUsers_();
  var record = users[name];
  if (!record || !record.salt || !record.hash || !AUTH_VALID_ROLES[record.role]) return { ok: false };

  var candidate = hashPassword_(password, record.salt);
  if (!hexDigestsMatch_(candidate, String(record.hash))) return { ok: false };

  return { ok: true, username: name, role: record.role, pwv: Number(record.pwv) || 0 };
}

// -------------------------------------------------------------- session tokens

function sessionSecret_() {
  var existing = getTelegramSetting_(OMAD_PROP_SESSION_SECRET);
  if (existing) return existing;
  var generated = (Utilities.getUuid() + Utilities.getUuid()).split("-").join("");
  setTelegramSetting_(OMAD_PROP_SESSION_SECRET, generated);
  return generated;
}

function signSessionClaims_(claims) {
  return bytesToHex_(Utilities.computeHmacSha256Signature(claims, sessionSecret_()));
}

/**
 * A session token: `v1.<username>.<role>.<expiry>.<pwv>.<nonce>.<signature>`.
 *
 * Deliberately not JSON-in-base64. Usernames are restricted to `[a-z0-9_]` and
 * roles to a fixed list, so no field can contain the separator and the format
 * needs neither an encoder nor a parser that could disagree with each other.
 *
 * Nothing here is secret — the claims are readable by whoever holds the token,
 * which is the person they describe. The signature is what makes them true.
 */
function issueSessionToken_(username, role, pwv, nowMs) {
  var now = nowMs === undefined ? Date.now() : nowMs;
  var expiry = Math.floor(now / 1000) + AUTH_SESSION_TTL_SECONDS;
  var nonce = Utilities.getUuid().split("-").join("");
  var claims = [AUTH_TOKEN_VERSION, username, role, String(expiry), String(pwv), nonce].join(".");
  return {
    token: claims + "." + signSessionClaims_(claims),
    expiresAt: expiry * 1000
  };
}

/**
 * Verifies one token. Returns `{ ok, username, role, reason }`.
 *
 * `reason` is a short code and never depends on a secret: `expired` is the one
 * the client acts on, by sending the user back to the login page instead of
 * showing an error over their data.
 */
function verifySessionToken_(token, nowMs) {
  var text = String(token === null || token === undefined ? "" : token);
  if (!text) return { ok: false, reason: "missing" };
  if (text.length > 512) return { ok: false, reason: "malformed" };

  var parts = text.split(".");
  if (parts.length !== 7 || parts[0] !== AUTH_TOKEN_VERSION) return { ok: false, reason: "malformed" };

  var username = parts[1];
  var role = parts[2];
  var expiry = Number(parts[3]);
  var pwv = Number(parts[4]);
  if (!AUTH_USERNAME_PATTERN.test(username) || !AUTH_VALID_ROLES[role] || !isFinite(expiry)) {
    return { ok: false, reason: "malformed" };
  }

  var claims = parts.slice(0, 6).join(".");
  if (!hexDigestsMatch_(signSessionClaims_(claims), parts[6])) return { ok: false, reason: "bad_signature" };

  var nowSeconds = Math.floor((nowMs === undefined ? Date.now() : nowMs) / 1000);
  if (nowSeconds >= expiry) return { ok: false, reason: "expired" };

  // The signature proves the claims were minted here; the stored record decides
  // whether they are still true. A changed password, a changed role or a
  // deleted user takes effect on the next request rather than in a month.
  var users = readAuthUsers_();
  var record = users[username];
  if (!record) {
    // The bootstrap session, which exists before the owner's account does and
    // stops existing the moment it is created. Nothing else can be minted
    // without a stored record, and this one still had to present the
    // maintenance key to be issued at all.
    if (username === AUTH_ROLE_OMAD_ADMIN && role === AUTH_ROLE_OMAD_ADMIN && pwv === 0 &&
        !omadAdminAccountConfigured_()) {
      return { ok: true, username: username, role: role, bootstrap: true };
    }
    return { ok: false, reason: "revoked" };
  }
  if (String(record.role) !== role) return { ok: false, reason: "revoked" };
  if ((Number(record.pwv) || 0) !== pwv) return { ok: false, reason: "revoked" };

  return { ok: true, username: username, role: role };
}

// --------------------------------------------------------------------- login

var LOGIN_THROTTLED_MESSAGE = "Juda ko'p urinish. Bir daqiqa kutib qayta urinib ko'ring.";

/**
 * Charges one attempt to the login buckets, before the password is checked.
 *
 * Reserve-then-refund, rather than check-then-charge. Checking first and
 * charging afterwards leaves the whole password hash — a couple of hundred HMAC
 * rounds — between reading the counter and writing it, so a burst of parallel
 * guesses could all read zero and collapse into one increment. Charging first
 * closes that window to the width of one cache round trip, and
 * `refundLoginAttempt_` gives the unit back when the password turns out to be
 * right, which is what keeps a correct sign-in free.
 *
 * The counter is still a cache read-modify-write, because Apps Script has no
 * atomic increment. Serialising it on the script lock was considered and
 * rejected: that is the same lock the financial writes take, so it would let
 * anyone with the /exec URL queue behind the ledger.
 */
function reserveLoginAttempt_(username) {
  var perUser = enforceRateLimit_(
    "login_u_" + username, LOGIN_FAILURE_LIMIT_PER_USER, TELEGRAM_RATE_WINDOW_SECONDS);
  if (perUser) return LOGIN_THROTTLED_MESSAGE;

  var global = enforceRateLimit_(
    "login_all", LOGIN_FAILURE_LIMIT_GLOBAL, TELEGRAM_RATE_WINDOW_SECONDS);
  if (global) {
    // The per-user unit was already taken; give it back so a global flood
    // caused by somebody else does not also fill this account's allowance.
    releaseRateLimit_("login_u_" + username);
    return LOGIN_THROTTLED_MESSAGE;
  }
  return "";
}

/** Returns the reserved attempt. Called only when the password was correct. */
function refundLoginAttempt_(username) {
  releaseRateLimit_("login_u_" + username);
  releaseRateLimit_("login_all");
}

/**
 * Signs a user in.
 *
 * The answer is deliberately the same sentence for an unknown user, a wrong
 * password and a throttled attempt beyond the throttle's own message, so the
 * page cannot be used to enumerate accounts.
 */
function loginAction_(payload) {
  var username = normalizeUsername_(payload && payload.username);
  var password = String((payload && payload.password) || "");

  if (!AUTH_USERNAME_PATTERN.test(username) || !password) {
    return { status: "error", code: "invalid_credentials", message: "Login yoki parol noto'g'ri." };
  }
  if (password.length > AUTH_MAX_PASSWORD_LENGTH) {
    return { status: "error", code: "invalid_credentials", message: "Login yoki parol noto'g'ri." };
  }

  var throttled = reserveLoginAttempt_(username);
  if (throttled) return { status: "error", code: "throttled", message: throttled };

  var verified = verifyUserPassword_(username, password);

  // Bootstrap. Until the owner has set the first password there is no user
  // store to check against, so the maintenance key stands in for exactly one
  // account: the one that can then create the others. It stops working the
  // moment any password is set, and the response says so.
  var bootstrap = false;
  if (!verified.ok && !omadAdminAccountConfigured_() && username === AUTH_ROLE_OMAD_ADMIN) {
    var keyError = checkAdminKey_({ adminKey: password });
    if (!keyError) {
      verified = { ok: true, username: username, role: AUTH_ROLE_OMAD_ADMIN, pwv: 0 };
      bootstrap = true;
    }
  }

  if (!verified.ok) {
    // The attempt is already charged; a wrong password simply does not get it
    // back.
    return { status: "error", code: "invalid_credentials", message: "Login yoki parol noto'g'ri." };
  }
  refundLoginAttempt_(username);

  var issued = issueSessionToken_(verified.username, verified.role, verified.pwv);
  return {
    status: "success",
    token: issued.token,
    expiresAt: issued.expiresAt,
    username: verified.username,
    role: verified.role,
    home: AUTH_ROLE_HOME[verified.role] || "login.html",
    bootstrap: bootstrap
  };
}

/** Lets a signed-in user replace their own password. */
function changePasswordAction_(auth, payload) {
  var current = String((payload && payload.currentPassword) || "");
  var next = String((payload && payload.newPassword) || "");

  if (auth.bootstrap) {
    // There is nothing to check the current password against yet, so this is
    // the first password rather than a change of one.
    var created = setUserCredential_(auth.username, next, auth.role);
    if (created.status !== "success") return created;
    var firstToken = issueSessionToken_(created.username, created.role, 1);
    return { status: "success", token: firstToken.token, expiresAt: firstToken.expiresAt, role: created.role };
  }

  var throttled = reserveLoginAttempt_(auth.username);
  if (throttled) return { status: "error", code: "throttled", message: throttled };

  var verified = verifyUserPassword_(auth.username, current);
  if (!verified.ok) {
    return { status: "error", code: "invalid_credentials", message: "Joriy parol noto'g'ri." };
  }
  refundLoginAttempt_(auth.username);

  var result = setUserCredential_(auth.username, next, verified.role);
  if (result.status !== "success") return result;

  // The old sessions — including this browser's — are invalid now, so a fresh
  // one is issued rather than silently signing the user out mid-task.
  var reissued = issueSessionToken_(result.username, result.role, (Number(verified.pwv) || 0) + 1);
  return { status: "success", token: reissued.token, expiresAt: reissued.expiresAt, role: result.role };
}

/** omad_admin creating or resetting an account, including the café ones. */
function setUserPasswordAction_(payload) {
  var result = setUserCredential_(payload && payload.username, (payload && payload.password) || "", payload && payload.role);
  if (result.status !== "success") return result;
  return {
    status: "success",
    username: result.username,
    role: result.role,
    created: result.created,
    users: listAuthUsers_()
  };
}

/** Who exists and what they may do. Never any salt, hash or password. */
function listAuthUsers_() {
  var users = readAuthUsers_();
  var rows = [];
  Object.keys(users).sort().forEach(function (name) {
    rows.push({
      username: name,
      role: String(users[name].role || ""),
      updatedAt: String(users[name].updatedAt || "")
    });
  });
  return rows;
}

// ------------------------------------------------------------- request gating

/**
 * Authorizes one web-app request against the roles an action allows.
 *
 * Order matters:
 *
 *   1. A session token is verified first, by signature. Forging one means
 *      forging an HMAC, so a failure here is a stale or absent session rather
 *      than evidence of guessing — which is why a valid session never consumes
 *      a failure allowance and can never be throttled by somebody else's.
 *   2. The admin key is compared only after its own strict rate limit, which
 *      is the property the endpoint has always had: it must not be usable to
 *      guess the key.
 *   3. Anything else is a failure, and failures share one strict bucket.
 *
 * Returns `{ ok, role, username }` or `{ ok: false, message, code }`, where
 * `code` is `auth` when the client should return to the login page and
 * `throttled` when it should simply try again shortly.
 */
function authorizeWebRequest_(payload, allowedRoles) {
  var token = payload && payload.sessionToken;

  if (token) {
    var session = verifySessionToken_(token);
    if (session.ok) {
      var throttled = enforceRateLimit_(
        "user_" + session.username, AUTHENTICATED_REQUEST_LIMIT, TELEGRAM_RATE_WINDOW_SECONDS);
      if (throttled) return { ok: false, code: "throttled", message: throttled };
      if (!roleAllowed_(session.role, allowedRoles)) {
        return { ok: false, code: "forbidden", message: "Bu amal uchun ruxsat yo'q." };
      }
      return { ok: true, role: session.role, username: session.username, bootstrap: !!session.bootstrap };
    }

    var expired = session.reason === "expired" || session.reason === "revoked";
    var failure = enforceRateLimit_("auth_fail", AUTH_FAILURE_LIMIT, TELEGRAM_RATE_WINDOW_SECONDS);
    if (failure && !expired) return { ok: false, code: "throttled", message: failure };
    return {
      ok: false,
      code: "auth",
      message: expired
        ? "Sessiya muddati tugadi. Qaytadan kiring."
        : "Kirish tasdiqlanmadi. Qaytadan kiring."
    };
  }

  if (payload && payload.adminKey) {
    var keyThrottled = enforceRateLimit_("auth_key", AUTH_FAILURE_LIMIT, TELEGRAM_RATE_WINDOW_SECONDS);
    if (keyThrottled) return { ok: false, code: "throttled", message: keyThrottled };

    var keyError = checkAdminKey_(payload);
    if (keyError) return { ok: false, code: "auth", message: keyError };
    if (!roleAllowed_(AUTH_ROLE_OMAD_ADMIN, allowedRoles)) {
      return { ok: false, code: "forbidden", message: "Bu amal uchun ruxsat yo'q." };
    }
    return { ok: true, role: AUTH_ROLE_OMAD_ADMIN, username: AUTH_ROLE_OMAD_ADMIN, viaAdminKey: true };
  }

  var anonymous = enforceRateLimit_("auth_fail", AUTH_FAILURE_LIMIT, TELEGRAM_RATE_WINDOW_SECONDS);
  if (anonymous) return { ok: false, code: "throttled", message: anonymous };
  return { ok: false, code: "auth", message: "Kirish tasdiqlanmadi. Qaytadan kiring." };
}

function roleAllowed_(role, allowedRoles) {
  if (!allowedRoles || allowedRoles.length === 0) return role === AUTH_ROLE_OMAD_ADMIN;
  for (var i = 0; i < allowedRoles.length; i++) {
    if (allowedRoles[i] === role) return true;
  }
  return false;
}

/** The refusal shape every gated handler returns, so clients can branch on it. */
function authRefusal_(auth) {
  return jsonOutput_({
    status: "error",
    code: auth.code || "auth",
    // The café screens sign out on this and only on this. A throttle or a
    // network fault must never look like an expired session, or a busy minute
    // empties the till's stock list and asks the cashier to log in again.
    authExpired: auth.code === "auth",
    message: auth.message
  });
}

/**
 * Run once from the Apps Script editor to create or reset an account.
 *
 * Exists so the first password can be set without a password already existing,
 * and without one ever being typed into a browser address bar or committed.
 * Nothing calls it; it is an operator tool.
 */
function setUserPassword(username, password, role) {
  var result = setUserCredential_(username, password, role);
  if (result.status !== "success") throw new Error(result.message);
  return result.username + " -> " + result.role;
}
