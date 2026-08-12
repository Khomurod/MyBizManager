'use strict';

// ==========================================================
// App shell
// ----------------------------------------------------------
// The gate runs first and nothing else runs until it passes: no tab renders,
// no data is requested, and the navigation stays hidden. A page opened outside
// Telegram, or by anyone who is not the authorized user, gets one sentence and
// no application.
// ==========================================================

const TABS = {
    omad: { render: renderOmad, load: loadOmad },
    cafe: { render: renderCafe, load: loadCafe },
    tasks: { render: renderTasks, load: loadTasks }
};

function showGate(icon, message, retry) {
    document.getElementById('app').classList.add('hidden');
    document.getElementById('nav').classList.add('hidden');
    const gate = document.getElementById('gate');
    gate.classList.remove('hidden');
    gate.querySelector('.ic').textContent = icon;
    document.getElementById('gateText').textContent = message;
    document.getElementById('gateRetry').classList.toggle('hidden', !retry);
}

function showApp() {
    document.getElementById('gate').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.getElementById('nav').classList.remove('hidden');
}

/**
 * Sends the app back to the gate.
 *
 * An expired session is the one case worth offering a retry for: reopening the
 * Mini App gives Telegram a chance to hand over a fresh signature. A refusal
 * is final, and saying so plainly is kinder than a button that will not work.
 */
function failAuth(error) {
    const stale = error && error.reason === 'stale';
    showGate(stale ? '⌛' : '🔒', error && error.message ? error.message : OPEN_IN_TELEGRAM_MESSAGE, stale);
    closeSheet();
}

function switchTab(name) {
    if (!TABS[name]) return;
    state.tab = name;
    haptic();

    for (const key of Object.keys(TABS)) {
        document.getElementById(`tab-${key}`).classList.toggle('hidden', key !== name);
        document.getElementById(`nav-${key}`).setAttribute('aria-selected', String(key === name));
    }
    window.scrollTo(0, 0);

    // Café and Tasks are fetched the first time they are opened rather than up
    // front, so the first paint is one request instead of three.
    if (name === 'cafe' && !state.cafe) loadCafe();
    else if (name === 'tasks' && !state.tasks) loadTasks();
    else TABS[name].render();
}

/**
 * The one call that decides everything.
 *
 * mini_home answers the Omad tab completely -- summary, tenant status and
 * recent entries -- and nothing else, so the first screen is one round trip
 * and one pass over the ledger.
 *
 * It used to return the café summary and the task counts too, and then this
 * function immediately called mini_omad anyway because the tenant list and the
 * entries were missing from it. That was two requests and four separate reads
 * of the whole ledger to paint one tab, plus a café read and a full task-view
 * build for tabs nobody had opened yet. Café and Tasks now load when they are
 * first opened.
 */
async function bootstrap() {
    showGate('⏳', 'Tekshirilmoqda...', false);

    if (!telegramInitData()) {
        showGate('📱', OPEN_IN_TELEGRAM_MESSAGE, false);
        return;
    }

    try {
        const body = await api('mini_home', { period: state.period || currentPeriod() });
        state.user = body.user;
        state.omad = body.omad;
        state.period = body.omad.period;
        state.tenants = body.tenants || [];
        state.entries = body.transactions || [];

        showApp();
        renderOmad();
    } catch (error) {
        if (error.unauthorized) return failAuth(error);
        showGate('⚠️', error.message || 'Xatolik', true);
    }
}

initTelegramChrome();
bootstrap();
