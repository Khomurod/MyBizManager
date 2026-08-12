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
 * mini_home returns the Omad summary, the café summary and the task counts
 * together, so the app is usable after a single round trip on a phone
 * connection. The detail for each tab is fetched when that tab is opened.
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
        state.cafe = body.cafe;
        state.taskCounts = body.tasks;

        showApp();
        renderOmad();
        // The tenant list and the recent entries are not in mini_home; this
        // fills them in without the user waiting for them to arrive first.
        loadOmad();
    } catch (error) {
        if (error.unauthorized) return failAuth(error);
        showGate('⚠️', error.message || 'Xatolik', true);
    }
}

initTelegramChrome();
bootstrap();
