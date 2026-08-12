'use strict';

// ==========================================================
// Mini App configuration and Telegram bootstrap
// ----------------------------------------------------------
// The page holds no credential of its own. The only thing that authorizes it
// is the signed `initData` Telegram gives the WebApp, which is forwarded
// verbatim to the backend and verified there against the bot token.
//
// initDataUnsafe is deliberately never read: it is the same payload without
// the signature, so trusting it would be trusting whoever opened the page.
// ==========================================================

const GOOGLE_APP_URL = "https://script.google.com/macros/s/AKfycbzhKyEOGZbVdtpSd7fa6aTDZf1QsqWQeOpWRxrb7bYpzWWDQxUXZID8JNzGMfDtCA2W/exec";

const OPEN_IN_TELEGRAM_MESSAGE = "Bu sahifani Telegram bot orqali oching.";

/** The Telegram WebApp bridge, or null when this page is open in a browser. */
function telegramApp() {
    return (window.Telegram && window.Telegram.WebApp) || null;
}

/** The signed payload, or "" when there is none to send. */
function telegramInitData() {
    const app = telegramApp();
    return (app && typeof app.initData === 'string') ? app.initData : "";
}

/**
 * Tells Telegram the page is ready and adopts its chrome.
 *
 * expand() gives the app the full sheet height rather than the short preview,
 * which matters because the tab bar is pinned to the bottom.
 */
function initTelegramChrome() {
    const app = telegramApp();
    if (!app) return;
    try {
        app.ready();
        app.expand();
        if (typeof app.setHeaderColor === 'function') app.setHeaderColor('bg_color');
        if (typeof app.disableVerticalSwipes === 'function') app.disableVerticalSwipes();
    } catch (error) {
        // An older Telegram client without one of these still runs the app.
    }
}

/** Haptic feedback where the client supports it; silently nothing where not. */
function haptic(kind) {
    const app = telegramApp();
    try {
        const h = app && app.HapticFeedback;
        if (!h) return;
        if (kind === 'error') h.notificationOccurred('error');
        else if (kind === 'success') h.notificationOccurred('success');
        else h.impactOccurred('light');
    } catch (error) {}
}

/** Telegram's own confirm dialog when available, the browser's otherwise. */
function askConfirm(message) {
    const app = telegramApp();
    return new Promise(resolve => {
        if (app && typeof app.showConfirm === 'function') {
            try { app.showConfirm(message, ok => resolve(!!ok)); return; } catch (error) {}
        }
        resolve(window.confirm(message));
    });
}
