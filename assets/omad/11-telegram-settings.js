'use strict';

// ==========================================================
// Telegram settings panel
// ----------------------------------------------------------
// The bot token is write-only from the browser: it is posted to the backend
// and never read back.
// ==========================================================

// --- TELEGRAM SETTINGS PANEL ---
// The bot token is write-only from the browser's point of view: it is
// posted to the backend and never read back.
let telegramSettings = null;

function tgFormatStamp(entry) {
    if (!entry || !entry.at) return "—";
    const when = new Date(entry.at);
    const stamp = isNaN(when.getTime()) ? entry.at : when.toLocaleString('uz-UZ');
    return entry.action ? `${entry.action} • ${stamp}` : stamp;
}

function tgShowMessage(text, isError) {
    const box = document.getElementById('tgMessage');
    if (!box) return;
    box.textContent = text;
    box.className = isError
        ? "text-[11px] font-bold rounded-lg p-2 bg-red-50 text-red-600 border border-red-100"
        : "text-[11px] font-bold rounded-lg p-2 bg-green-50 text-green-700 border border-green-100";
}

function renderTelegramSettings(settings, botInfo) {
    if (settings) telegramSettings = settings;
    const s = telegramSettings || {};

    const tokenEl = document.getElementById('tgTokenStatus');
    if (tokenEl) {
        tokenEl.textContent = s.tokenConfigured ? "✅ O'rnatilgan" : "❌ O'rnatilmagan";
        tokenEl.className = s.tokenConfigured ? "font-bold text-green-600" : "font-bold text-red-500";
    }

    const botEl = document.getElementById('tgBotStatus');
    if (botEl && botInfo) {
        botEl.textContent = botInfo.username ? `✅ @${botInfo.username}` : "✅ Ulandi";
        botEl.className = "font-bold text-green-600";
    }

    const hookEl = document.getElementById('tgWebhookStatus');
    if (hookEl) {
        const hook = s.webhookStatus;
        if (!hook) {
            hookEl.textContent = "Noma'lum";
            hookEl.className = "font-bold text-slate-400";
        } else if (hook.configured) {
            hookEl.textContent = `✅ Faol (${hook.pendingUpdateCount || 0} kutilmoqda)`;
            hookEl.className = "font-bold text-green-600";
        } else {
            hookEl.textContent = "❌ Sozlanmagan";
            hookEl.className = "font-bold text-red-500";
        }
    }

    const okEl = document.getElementById('tgLastSuccess');
    if (okEl) okEl.textContent = tgFormatStamp(s.lastSuccess);

    const errEl = document.getElementById('tgLastError');
    if (errEl) errEl.textContent = s.lastError ? `${tgFormatStamp(s.lastError)}: ${s.lastError.message || ""}` : "—";

    const userInput = document.getElementById('tgAuthorizedUserId');
    if (userInput && !userInput.value) userInput.value = s.authorizedUserId || "";
    const groupInput = document.getElementById('tgGroupChatId');
    if (groupInput && !groupInput.value) groupInput.value = s.groupChatId || "";
    const hookInput = document.getElementById('tgWebhookUrl');
    if (hookInput && !hookInput.value) hookInput.value = s.webhookUrl || GOOGLE_APP_URL.trim();
}

async function loadTelegramSettings() {
    try {
        const data = await callBackend({ action: 'get_telegram_settings' });
        if (data && data.settings) renderTelegramSettings(data.settings);
    } catch (e) {
        console.log("Telegram sozlamalarini yuklab bo'lmadi");
    }
}

function tgAdminKey() {
    return document.getElementById('tgAdminKey').value.trim();
}

async function tgAdminAction(payload, successText) {
    const adminKey = tgAdminKey();
    if (!adminKey) {
        tgShowMessage("Admin kalitini kiriting.", true);
        return null;
    }
    tgShowMessage("Bajarilmoqda...", false);
    try {
        const data = await callBackend({ ...payload, adminKey });
        if (data && data.settings) renderTelegramSettings(data.settings, data.bot);
        if (!data || data.status !== 'success') {
            tgShowMessage((data && data.message) || "Xatolik yuz berdi.", true);
            return null;
        }
        tgShowMessage(successText, false);
        return data;
    } catch (e) {
        tgShowMessage("Server bilan bog'lanib bo'lmadi.", true);
        return null;
    }
}

async function saveTelegramSettings() {
    const tokenInput = document.getElementById('tgBotToken');
    const payload = {
        action: 'save_telegram_settings',
        authorizedUserId: document.getElementById('tgAuthorizedUserId').value.trim(),
        groupChatId: document.getElementById('tgGroupChatId').value.trim()
    };
    const token = tokenInput.value.trim();
    if (token) payload.botToken = token;
    if (!token && !(telegramSettings && telegramSettings.tokenConfigured)) {
        tgShowMessage("Bot tokeni kiritilmagan.", true);
        return;
    }

    const result = await tgAdminAction(payload, "Sozlamalar saqlandi.");
    // Clear the token field either way so it never lingers in the DOM.
    tokenInput.value = "";
    if (result) await loadTelegramSettings();
}

async function testTelegramConnection() {
    await tgAdminAction({ action: 'test_telegram_connection' }, "Bot ulanishi muvaffaqiyatli.");
}

async function sendTelegramTestMessage() {
    await tgAdminAction({ action: 'send_telegram_test_message' }, "Test xabari yuborildi.");
}

async function configureTelegramWebhook() {
    await tgAdminAction({
        action: 'configure_telegram_webhook',
        webhookUrl: document.getElementById('tgWebhookUrl').value.trim()
    }, "Webhook sozlandi.");
}
