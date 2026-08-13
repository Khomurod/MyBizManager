'use strict';

// ==========================================================
// Configuration & access guard
// ----------------------------------------------------------
// Telegram credentials are NOT stored in the browser. The bot token, admin key
// and webhook secret live in Apps Script Script Properties; every Telegram call
// goes through the Apps Script backend as a business operation.
//
// The browser holds one thing: a signed session token issued at login. It is
// sent with every request and the server decides, from the role inside it,
// what this person may do. The guard below only chooses whether to render.
// ==========================================================

const GOOGLE_APP_URL = "https://script.google.com/macros/s/AKfycbzhKyEOGZbVdtpSd7fa6aTDZf1QsqWQeOpWRxrb7bYpzWWDQxUXZID8JNzGMfDtCA2W/exec";

// Rendering the accounting app to somebody without an omad_admin session is
// pointless rather than dangerous: every request it would make is refused on
// the server. Sending them to the login page is the useful response.
requireSessionRole('omad_admin');
