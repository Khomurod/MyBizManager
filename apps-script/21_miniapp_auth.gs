// ============================================================
// Telegram Mini App authentication
// ------------------------------------------------------------
// The Mini App is opened from inside Telegram, which hands the page a signed
// `initData` string. Telegram signs it with a key derived from the bot token,
// so a caller who does not hold the bot token cannot produce a valid one — and
// the bot token never leaves Script Properties.
//
// This is the ONLY thing that authorizes a Mini App request. In particular it
// never trusts:
//
//   - a user id in the URL or the payload
//   - a username (changeable, and re-registrable by someone else)
//   - `initDataUnsafe` (the client-side copy, unsigned by definition)
//   - anything stored in the browser
//
// There is no second user database. The verified numeric id is compared
// against TELEGRAM_AUTHORIZED_USER_ID — the same property that decides who may
// run /yangi and file a task from the bot.
// ============================================================

/**
 * How old a signed payload may be.
 *
 * Telegram refreshes `initData` when the Mini App is opened, but not while it
 * stays open, so this is a session length rather than a request lifetime: too
 * short and a Mini App left open in the background stops working mid-edit.
 * A day is long enough for that and short enough that a captured payload —
 * which would already require access to the authorized user's device — is not
 * usable indefinitely.
 */
var MINI_APP_MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;

/** Rate limit for verification attempts, so the endpoint cannot be hammered. */
var MINI_APP_RATE_LIMIT = 60;

var MINI_APP_OPEN_IN_TELEGRAM_MESSAGE = "Bu sahifani Telegram bot orqali oching.";
var MINI_APP_FORBIDDEN_MESSAGE = "⛔️ Sizda bu ilovadan foydalanish huquqi yo'q.";

/** Percent-decoding for one `application/x-www-form-urlencoded` component. */
function decodeQueryComponent_(value) {
  var text = String(value === null || value === undefined ? "" : value).split("+").join(" ");
  try {
    return decodeURIComponent(text);
  } catch (error) {
    // A malformed escape is not a reason to throw: it simply will not match
    // the signature, which is the answer we want anyway.
    return text;
  }
}

/**
 * initData as an ordered list of raw `key=value` pairs.
 *
 * The values must be compared *decoded* but signed *decoded* too, per
 * Telegram's rules: the data-check string is built from decoded values.
 */
function parseInitDataPairs_(initData) {
  var text = String(initData || "");
  if (!text) return [];
  var parts = text.split("&");
  var pairs = [];
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    var split = parts[i].indexOf("=");
    if (split === -1) continue;
    pairs.push({
      key: decodeQueryComponent_(parts[i].slice(0, split)),
      value: decodeQueryComponent_(parts[i].slice(split + 1))
    });
  }
  return pairs;
}

function bytesToHex_(bytes) {
  var out = "";
  for (var i = 0; i < bytes.length; i++) {
    // Apps Script signature bytes are signed; & 0xff brings them back.
    var part = (bytes[i] & 0xff).toString(16);
    out += part.length === 1 ? "0" + part : part;
  }
  return out;
}

/**
 * Compares two hex digests without leaking where they first differ.
 *
 * secretsMatch_ already does this for the webhook secret; this keeps the same
 * property for a value an attacker can submit repeatedly.
 */
function hexDigestsMatch_(a, b) {
  var left = String(a || "").toLowerCase();
  var right = String(b || "").toLowerCase();
  if (left.length !== right.length) return false;
  var difference = 0;
  for (var i = 0; i < left.length; i++) {
    difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return difference === 0;
}

/**
 * Verifies Telegram's signature over initData.
 *
 * Returns `{ ok, user, authDate, reason }`. `reason` is a short machine
 * readable code; nothing it contains is ever derived from a secret.
 */
function verifyTelegramInitData_(initData, nowMs) {
  var token = getBotToken_();
  if (!token) return { ok: false, reason: "bot_token_missing" };

  var pairs = parseInitDataPairs_(initData);
  if (pairs.length === 0) return { ok: false, reason: "missing_init_data" };

  var hash = "";
  var checkPairs = [];
  for (var i = 0; i < pairs.length; i++) {
    if (pairs[i].key === "hash") { hash = pairs[i].value; continue; }
    checkPairs.push(pairs[i]);
  }
  if (!hash) return { ok: false, reason: "missing_hash" };

  checkPairs.sort(function (a, b) { return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0); });
  var lines = [];
  for (var j = 0; j < checkPairs.length; j++) {
    lines.push(checkPairs[j].key + "=" + checkPairs[j].value);
  }
  var dataCheckString = lines.join("\n");

  // secret_key = HMAC_SHA256(bot_token, "WebAppData"), then the digest of the
  // data-check string under that key. Both steps are HMAC(message, key).
  var secretKey = Utilities.computeHmacSha256Signature(token, "WebAppData");
  var digest = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(dataCheckString).getBytes(), secretKey);

  if (!hexDigestsMatch_(bytesToHex_(digest), hash)) return { ok: false, reason: "bad_signature" };

  var authDate = 0;
  for (var k = 0; k < checkPairs.length; k++) {
    if (checkPairs[k].key === "auth_date") authDate = Number(checkPairs[k].value) || 0;
  }
  if (!authDate) return { ok: false, reason: "missing_auth_date" };

  var now = Math.floor((nowMs === undefined ? Date.now() : nowMs) / 1000);
  // A payload dated in the future is as wrong as one that is too old.
  if (authDate > now + 300) return { ok: false, reason: "auth_date_in_future" };
  if (now - authDate > MINI_APP_MAX_AUTH_AGE_SECONDS) return { ok: false, reason: "stale" };

  var user = null;
  for (var u = 0; u < checkPairs.length; u++) {
    if (checkPairs[u].key === "user") user = safeParseJSON_(checkPairs[u].value, null);
  }
  if (!user || (user.id === undefined || user.id === null || user.id === "")) {
    return { ok: false, reason: "missing_user" };
  }

  return { ok: true, user: user, authDate: authDate, reason: "" };
}

/**
 * Authorizes one Mini App request.
 *
 * Signature first, then identity: a valid signature proves the payload came
 * from Telegram, and only then does the verified numeric id decide whether
 * this particular person may see anything.
 */
function authorizeMiniAppRequest_(payload) {
  var throttled = enforceRateLimit_("mini_auth", MINI_APP_RATE_LIMIT, TELEGRAM_RATE_WINDOW_SECONDS);
  if (throttled) return { ok: false, message: throttled };

  var verified = verifyTelegramInitData_((payload && payload.initData) || "");
  if (!verified.ok) {
    return {
      ok: false,
      reason: verified.reason,
      // Nothing here tells a caller how to forge a better attempt.
      message: verified.reason === "stale"
        ? "Sessiya muddati tugadi. Ilovani qaytadan oching."
        : MINI_APP_OPEN_IN_TELEGRAM_MESSAGE
    };
  }

  if (!isAuthorizedTelegramUser_(verified.user.id)) {
    return { ok: false, reason: "not_authorized", message: MINI_APP_FORBIDDEN_MESSAGE };
  }

  return {
    ok: true,
    userId: String(verified.user.id),
    user: {
      id: String(verified.user.id),
      firstName: String(verified.user.first_name || "").slice(0, 100),
      username: String(verified.user.username || "").slice(0, 100)
    }
  };
}
