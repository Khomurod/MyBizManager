'use strict';

// ==========================================================
// System and Data panel
// ----------------------------------------------------------
// Backup status, migration state, the retry queue, recent audit history,
// schema version and the last successful server operation.
//
// Everything here is read-only unless the admin key is supplied. The key is
// typed in the Telegram section and is never stored.
// ==========================================================

let systemStatus = null;

/**
 * The optional maintenance key.
 *
 * Nothing here needs one any more: the session token carries the omad_admin
 * role and the server checks it. The Telegram section's field remains for the
 * break-glass case - running a maintenance action against a project whose user
 * store is not set up yet - and when it is empty the request simply goes out
 * on the session, as every other request does.
 */
function systemAdminKey() {
    const input = document.getElementById('tgAdminKey');
    return input ? input.value.trim() : "";
}

/**
 * The payload additions an admin action needs.
 *
 * Returns an empty object when the session alone is the credential, which is
 * the normal case. It used to return "" and abort when no key had been typed,
 * which is why every maintenance button asked for a key that the browser was
 * already holding.
 */
function adminCredentials() {
    const key = systemAdminKey();
    return key ? { adminKey: key } : {};
}

// -------------------------------------------------------------- user accounts

/**
 * The accounts that can sign in, and what they may do.
 *
 * Passwords are hashed on the server and never leave it, so this lists who
 * exists and sets new passwords; it can never show one.
 */
async function loadUserAccounts() {
    const box = document.getElementById('userList');
    if (!box) return;
    try {
        const data = await callBackend(Object.assign({ action: 'list_users' }, adminCredentials()));
        if (!data || data.status !== 'success') {
            box.innerHTML = `<p class="text-amber-600 font-bold">${escapeHtmlText((data && data.message) || "Ro'yxatni o'qib bo'lmadi.")}</p>`;
            return;
        }
        if (!data.users.length) {
            box.innerHTML = `<p class="text-amber-600 font-bold">Hali birorta parol o'rnatilmagan. Quyida o'rnating.</p>`;
            return;
        }
        box.innerHTML = data.users.map(user => statusRow(
            escapeHtmlText(user.username),
            escapeHtmlText(user.role) + (user.updatedAt ? ` · ${formatStamp(user.updatedAt)}` : '')
        )).join('');
    } catch (e) {
        box.innerHTML = `<p class="text-slate-400">Server bilan bog'lanib bo'lmadi.</p>`;
    }
}

function showUserMessage(text, isError) {
    const box = document.getElementById('userMessage');
    if (!box) return;
    box.textContent = text;
    box.className = `text-[11px] font-bold mt-2 ${isError ? 'text-red-500' : 'text-emerald-600'}`;
    box.classList.remove('hidden');
}

async function saveUserPassword() {
    const username = document.getElementById('userAccount').value;
    const password = document.getElementById('userPassword').value;
    const repeat = document.getElementById('userPasswordRepeat').value;

    if (password.length < 8) return showUserMessage("Parol kamida 8 ta belgidan iborat bo'lishi kerak.", true);
    if (password !== repeat) return showUserMessage("Parollar mos kelmadi.", true);

    showLoader(true);
    try {
        const data = await callBackend(Object.assign({
            action: 'set_user_password', username, password, role: username
        }, adminCredentials()));
        if (!data || data.status !== 'success') {
            showUserMessage((data && data.message) || "Saqlanmadi.", true);
            return;
        }
        document.getElementById('userPassword').value = '';
        document.getElementById('userPasswordRepeat').value = '';
        showUserMessage(`${data.username} paroli o'rnatildi.`, false);
        await loadUserAccounts();
        // Changing your own password invalidates the token this page is
        // holding, so it has to be replaced rather than discovered later as a
        // sudden trip to the login screen.
        if (data.username === sessionUser()) {
            const relogin = await callBackend({ action: 'login', username: data.username, password });
            if (relogin && relogin.status === 'success') storeSession(relogin.token, relogin.expiresAt);
            else signOut();
        }
    } catch (e) {
        showUserMessage("Server bilan bog'lanib bo'lmadi.", true);
    } finally {
        showLoader(false);
    }
}

function formatStamp(value) {
    if (!value) return "—";
    const when = new Date(value);
    return isNaN(when.getTime()) ? String(value) : when.toLocaleString('uz-UZ');
}

function statusRow(label, value, tone = "text-slate-700") {
    return `<div class="flex justify-between gap-2">
                <span class="text-slate-400 shrink-0">${label}</span>
                <span class="${tone} font-bold text-right break-words">${value}</span>
            </div>`;
}

async function loadSystemStatus() {
    try {
        const data = await callBackend({ action: 'get_system_status' });
        systemStatus = (data && data.system) || null;
    } catch (e) {
        systemStatus = null;
    }
    renderSystemPanel();
    loadUserAccounts();
}

function renderSystemPanel() {
    renderSystemOverview();
    renderBackupStatus();
    renderJobQueueStatus();
    renderMigrationPanel();
    renderAuditList();
}

function renderSystemOverview() {
    const box = document.getElementById('systemOverview');
    if (!box) return;

    if (!systemStatus) {
        box.innerHTML = `<p class="text-slate-400">Server bilan bog'lanib bo'lmadi.</p>`;
        return;
    }

    const last = systemStatus.lastOperation;
    box.innerHTML = [
        statusRow("Tizim versiyasi", `v${systemStatus.schemaVersion}`),
        statusRow("Faol varaq", systemStatus.ledgerActive ? "Yangi (V2)" : "Eski",
            systemStatus.ledgerActive ? "text-green-600" : "text-slate-700"),
        statusRow("Tranzaksiyalar", String(systemStatus.ledgerActive
            ? systemStatus.counts.ledgerTransactions
            : systemStatus.counts.legacyTransactions)),
        statusRow("Oxirgi server amali",
            last ? `${last.operation} • ${formatStamp(last.at)}` : "—")
    ].join('');
}

function renderBackupStatus() {
    const box = document.getElementById('backupStatus');
    if (!box) return;
    if (!systemStatus) { box.innerHTML = ""; return; }

    const backup = systemStatus.backup || {};
    box.innerHTML = backup.count
        ? [
            statusRow("Zaxira nusxalar", String(backup.count)),
            statusRow("Oxirgisi", formatStamp(backup.lastAt)),
            statusRow("Sababi", backup.lastReason || "—"),
            statusRow("Yozuvlar soni", String(backup.lastTransactionCount || 0))
          ].join('')
        : `<p class="text-slate-400">Hali zaxira nusxa olinmagan.</p>`;
}

function renderJobQueueStatus() {
    const box = document.getElementById('jobQueueStatus');
    if (!box) return;
    if (!systemStatus) { box.innerHTML = ""; return; }

    const counts = (systemStatus.queue && systemStatus.queue.counts) || {};
    const failures = (systemStatus.queue && systemStatus.queue.failures) || [];

    const rows = [
        statusRow("Kutilmoqda", String(counts.pending || 0),
            counts.pending ? "text-amber-600" : "text-slate-700"),
        statusRow("Bajarilmoqda", String(counts.processing || 0)),
        statusRow("Yakunlangan", String(counts.completed || 0)),
        statusRow("Xatolik", String(counts.failed || 0),
            counts.failed ? "text-red-600" : "text-slate-700")
    ];

    if (failures.length) {
        rows.push(`<div class="border-t pt-2 mt-2 space-y-1">` + failures.map(f =>
            `<p class="text-red-500 break-words">${escapeHTML(f.type)}: ${escapeHTML(f.lastError || '')}</p>`
        ).join('') + `</div>`);
    }

    box.innerHTML = rows.join('');
}

function renderAuditList() {
    const box = document.getElementById('auditList');
    if (!box) return;

    const entries = (systemStatus && systemStatus.audit) || [];
    box.innerHTML = entries.length
        ? entries.map(entry => `
            <div class="border-b border-slate-50 last:border-0 py-1">
                <div class="flex justify-between gap-2">
                    <span class="font-bold text-slate-600 break-words">${escapeHTML(entry.event)}</span>
                    <span class="text-slate-400 shrink-0">${formatStamp(entry.at)}</span>
                </div>
            </div>`).join('')
        : `<p class="text-slate-400">Amallar tarixi bo'sh.</p>`;
}

// ------------------------------------------------------------------ actions

async function createBackup() {
    showLoader(true);
    try {
        const data = await callBackend(Object.assign({ action: 'create_backup' }, adminCredentials()));
        if (data && data.status === 'success') {
            systemStatus = data.system || systemStatus;
            renderSystemPanel();
            alert("Zaxira nusxa yaratildi.");
        } else {
            alert((data && data.message) || "Xatolik yuz berdi.");
        }
    } catch (e) {
        alert("Server bilan bog'lanib bo'lmadi.");
    } finally {
        showLoader(false);
    }
}

async function processPendingJobs() {
    showLoader(true);
    try {
        const data = await callBackend(Object.assign({ action: 'process_jobs' }, adminCredentials()));
        if (data && data.status === 'success') {
            alert(`${data.processed || 0} ta vazifa bajarildi.`);
            await loadSystemStatus();
        } else {
            alert((data && data.message) || "Xatolik yuz berdi.");
        }
    } catch (e) {
        alert("Server bilan bog'lanib bo'lmadi.");
    } finally {
        showLoader(false);
    }
}

async function retryFailedJobs() {
    showLoader(true);
    try {
        const data = await callBackend(Object.assign({ action: 'retry_failed_jobs' }, adminCredentials()));
        if (data && data.status === 'success') {
            systemStatus = data.system || systemStatus;
            renderSystemPanel();
            alert(`${data.retried || 0} ta vazifa navbatga qaytarildi.`);
        } else {
            alert((data && data.message) || "Xatolik yuz berdi.");
        }
    } catch (e) {
        alert("Server bilan bog'lanib bo'lmadi.");
    } finally {
        showLoader(false);
    }
}

// ---------------------------------------------------------------- migration

/**
 * The migration controls are only useful until the cutover succeeds. Once the
 * ledger is live they are hidden, leaving just the rollback.
 */
function renderMigrationPanel() {
    const card = document.getElementById('migrationCard');
    const box = document.getElementById('migrationStatus');
    if (!card || !box) return;

    const migration = (systemStatus && systemStatus.migration) || null;
    if (!migration) { box.innerHTML = ""; return; }

    const stateLabels = {
        not_started: "Boshlanmagan",
        applied: "Ko'chirildi, hali yoqilmagan",
        cutover: "Yoqilgan",
        rolled_back: "Orqaga qaytarilgan"
    };

    box.innerHTML = [
        statusRow("Holat", stateLabels[migration.state] || migration.state),
        statusRow("Eski varaq", `${migration.sourceSheetRows} ta yozuv`),
        statusRow("Yangi varaq", migration.versionedSheetExists
            ? `${migration.versionedSheetRows} ta yozuv` : "yo'q"),
        statusRow("Zaxira yil", migration.fallbackYear ? String(migration.fallbackYear) : "tanlanmagan")
    ].join('');

    card.classList.toggle('opacity-60', migration.state === 'cutover');
    populateFallbackYears(migration.fallbackYear);
}

function populateFallbackYears(selected) {
    const select = document.getElementById('migrationFallbackYear');
    if (!select || select.options.length > 0) return;

    const years = [];
    for (let year = currentYear() - 6; year <= currentYear() + 1; year++) years.push(year);

    select.innerHTML = `<option value="">Tanlanmagan</option>` + years
        .map(year => `<option value="${year}"${year === Number(selected) ? ' selected' : ''}>${year}</option>`)
        .join('');
}

function selectedFallbackYear() {
    const select = document.getElementById('migrationFallbackYear');
    return select ? Number(select.value) || 0 : 0;
}

async function migrationAction(action, confirmText) {
    if (confirmText && !confirm(confirmText)) return null;

    showLoader(true);
    try {
        return await callBackend(Object.assign({ action, fallbackYear: selectedFallbackYear() }, adminCredentials()));
    } catch (e) {
        alert("Server bilan bog'lanib bo'lmadi.");
        return null;
    } finally {
        showLoader(false);
    }
}

async function previewMigration() {
    const data = await migrationAction('preview_omad_migration');
    if (!data) return;

    const box = document.getElementById('migrationPreview');
    box.classList.remove('hidden');

    if (data.status !== 'success') {
        box.innerHTML = `<p class="text-red-500 font-bold">${escapeHTML(data.message || 'Xatolik')}</p>`;
        return;
    }

    const preview = data.preview;
    const byYear = Object.keys(preview.byYear || {}).sort()
        .map(year => `<div class="flex justify-between"><span>${year}</span><b>${preview.byYear[year]} ta</b></div>`)
        .join('') || `<p class="text-slate-400">Yozuv yo'q</p>`;

    const unresolved = (preview.unresolved || []).length
        ? `<div class="border-t pt-2 mt-2">
             <p class="font-bold text-red-500 mb-1">Yili aniqlanmagan (${preview.unresolved.length} ta):</p>
             ${preview.unresolved.slice(0, 10).map(row =>
                `<p class="text-slate-500 break-words">Qator ${row.rowNumber}: ${escapeHTML(row.month)} / ${escapeHTML(row.date)}</p>`).join('')}
           </div>`
        : `<p class="text-green-600 font-bold border-t pt-2 mt-2">Barcha yozuvlarning yili aniqlandi.</p>`;

    box.innerHTML = `
        <p class="font-bold text-slate-700 mb-2">Jami ${preview.totalRows} ta yozuv</p>
        <div class="space-y-1">${byYear}</div>
        ${unresolved}
        <p class="mt-2 ${preview.canApply ? 'text-green-600' : 'text-red-500'} font-bold">
            ${preview.canApply ? "Ko'chirishga tayyor." : "Hali ko'chirib bo'lmaydi."}
        </p>`;
}

async function applyMigration() {
    const data = await migrationAction('apply_omad_migration',
        "Ma'lumotlar yangi varaqqa ko'chiriladi. Asl varaq o'zgarmaydi. Davom etamizmi?");
    if (!data) return;

    if (data.status !== 'success') {
        alert(data.message || "Xatolik yuz berdi.");
    } else {
        alert(`Ko'chirildi. Tekshiruv: ${data.verification && data.verification.ok ? "muvaffaqiyatli" : "xatolik"}.`);
    }
    await loadSystemStatus();
}

async function verifyMigration() {
    const data = await migrationAction('verify_omad_migration');
    if (!data) return;

    const verification = data.verification || {};
    alert(verification.ok
        ? `Tekshiruv muvaffaqiyatli. ${verification.targetRows} ta yozuv mos keldi.`
        : `Tekshiruv o'tmadi:\n${(verification.failures || []).slice(0, 5).join('\n')}`);
    await loadSystemStatus();
}

async function cutoverMigration() {
    const data = await migrationAction('cutover_omad_migration',
        "Dastur yangi varaqdan o'qishga o'tadi. Davom etamizmi?");
    if (!data) return;

    alert(data.status === 'success'
        ? "Yangi tizim yoqildi."
        : (data.message || "Xatolik yuz berdi."));
    await loadSystemStatus();
    await syncData();
}

async function rollbackMigration() {
    const data = await migrationAction('rollback_omad_migration',
        "Dastur eski varaqqa qaytadi. Ko'chirilgan ma'lumotlar o'chirilmaydi. Davom etamizmi?");
    if (!data) return;

    alert(data.status === 'success' ? "Orqaga qaytarildi." : (data.message || "Xatolik yuz berdi."));
    await loadSystemStatus();
    await syncData();
}

// ==========================================================
// Data maintenance
// ----------------------------------------------------------
// One-off repairs. Each of them backs up before it writes, is safe to press
// twice, and reports counts rather than contents.
// ==========================================================

function setMaintenanceStatus(html) {
    const box = document.getElementById('maintenanceStatus');
    if (box) box.innerHTML = html;
}

function describeDateAudit(audit) {
    if (!audit) return "";
    return [
        statusRow("Jami yozuv", audit.total),
        statusRow("Sanasi to'g'ri", audit.correct, "text-green-600"),
        statusRow("Tuzatish mumkin", audit.transposed, audit.transposed ? "text-amber-600" : "text-slate-700"),
        statusRow("Isbotlanmagan", audit.unprovable, audit.unprovable ? "text-slate-500" : "text-slate-700")
    ].join('');
}

async function maintenanceCall(payload, confirmText) {
    if (confirmText && !confirm(confirmText)) return null;

    showLoader(true);
    try {
        return await callBackend(Object.assign({}, payload, adminCredentials()));
    } finally {
        showLoader(false);
    }
}

async function auditTransactionDates() {
    const data = await maintenanceCall({ action: 'audit_transaction_dates' });
    if (!data) return;
    if (data.status !== 'success') return alert(data.message || "Xatolik yuz berdi.");
    setMaintenanceStatus(describeDateAudit(data.audit));
}

async function fixTransactionDates() {
    const data = await maintenanceCall(
        { action: 'fix_transaction_dates' },
        "Faqat tranzaksiya ID'si bilan isbotlangan sanalar tuzatiladi. Avval zaxira olinadi. Davom etamizmi?");
    if (!data) return;
    if (data.status !== 'success') return alert(data.message || "Xatolik yuz berdi.");

    setMaintenanceStatus(describeDateAudit(data.audit));
    alert(`${data.fixed} ta sana tuzatildi.`);
    await loadSystemStatus();
    await syncData();
}

async function backfillEntryGroups() {
    const data = await maintenanceCall({ action: 'backfill_entry_group_ids' });
    if (!data) return;
    if (data.status !== 'success') return alert(data.message || "Xatolik yuz berdi.");
    alert(`${data.filled} ta yozuvga guruh ID berildi (${data.alreadySet} tasida allaqachon bor edi).`);
    await syncData();
}

async function purgeTelegramLogSecrets() {
    const data = await maintenanceCall(
        { action: 'purge_telegram_debug_secrets' },
        "Eski Telegram loglaridagi maxfiy qiymatlar o'chiriladi. Avval nusxa olinadi. Davom etamizmi?");
    if (!data) return;
    if (data.status !== 'success') return alert(data.message || "Xatolik yuz berdi.");
    alert(`${data.rows} ta qatordan ${data.redacted} tasi tozalandi.`);
    await loadSystemStatus();
}

async function rotateWebhookSecret() {
    const data = await maintenanceCall(
        { action: 'rotate_telegram_webhook_secret' },
        "Webhook maxfiy kaliti yangilanadi va Telegram qayta ulanadi. Davom etamizmi?");
    if (!data) return;
    if (data.status !== 'success') return alert(data.message || "Xatolik yuz berdi.");

    alert("Webhook kaliti almashtirildi va tekshirildi.");
    if (typeof loadTelegramSettings === 'function') await loadTelegramSettings();
    await loadSystemStatus();
}

// ==========================================================
// System health & Mini App configuration
// ----------------------------------------------------------
// Green / warning / error with one sentence each. The report carries counts
// and status only - never a secret, a chat id or a deployment URL.
// ==========================================================

const HEALTH_TONES = {
    ok: { dot: 'bg-green-500', text: 'text-slate-600' },
    warning: { dot: 'bg-amber-500', text: 'text-amber-700' },
    error: { dot: 'bg-red-500', text: 'text-red-600' }
};

function healthRow(check) {
    const tone = HEALTH_TONES[check.status] || HEALTH_TONES.warning;
    return `<div class="flex items-start gap-2 py-1">
                <span class="w-2 h-2 rounded-full ${tone.dot} mt-1.5 shrink-0"></span>
                <span class="font-bold text-slate-600 shrink-0">${check.label}</span>
                <span class="${tone.text} text-right ml-auto break-words">${check.message}</span>
            </div>`;
}

function renderHealthReport(health) {
    const box = document.getElementById('healthReport');
    if (!box) return;
    if (!health) {
        box.innerHTML = `<p class="text-slate-400">Ma'lumot yo'q.</p>`;
        return;
    }
    const summary = health.status === 'ok'
        ? `<p class="font-bold text-green-600 mb-2">✅ Hammasi joyida</p>`
        : health.status === 'warning'
            ? `<p class="font-bold text-amber-600 mb-2">⚠️ E'tibor talab qiladi</p>`
            : `<p class="font-bold text-red-600 mb-2">⛔️ Muammo bor</p>`;
    box.innerHTML = summary + (health.checks || []).map(healthRow).join('');
}

async function runHealthCheck() {
    const data = await maintenanceCall({ action: 'get_health' });
    if (!data) return;
    if (data.status !== 'success') return alert(data.message || "Xatolik yuz berdi.");
    renderHealthReport(data.health);
}

function renderMiniAppStatus(settings) {
    const box = document.getElementById('miniAppStatus');
    if (!box) return;
    const input = document.getElementById('miniAppUrl');
    if (input && settings && settings.miniAppUrl && !input.value) input.value = settings.miniAppUrl;

    const status = settings && settings.miniAppStatus;
    if (!status) {
        box.innerHTML = `<span class="text-slate-400">Hali sozlanmagan.</span>`;
        return;
    }
    box.innerHTML = status.ready
        ? `<span class="text-green-600 font-bold">✅ Tayyor</span> <span class="text-slate-400">· ${formatStamp(status.checkedAt)}</span>`
        : `<span class="text-amber-600 font-bold">⚠️ To'liq sozlanmagan</span> <span class="text-slate-400">· ${formatStamp(status.checkedAt)}</span>`;
}

async function configureMiniApp() {
    const input = document.getElementById('miniAppUrl');
    const data = await maintenanceCall({
        action: 'configure_mini_app',
        miniAppUrl: input ? input.value.trim() : ""
    });
    if (!data) return;
    if (data.status !== 'success') return alert(data.message || "Xatolik yuz berdi.");

    renderMiniAppStatus(data.settings);
    const steps = (data.steps || []).map(s => `${s.status === 'ok' ? '✅' : '⛔️'} ${s.label}: ${s.message}`).join('\n');
    alert((data.ready ? "Mini App tayyor.\n\n" : "Mini App to'liq sozlanmadi.\n\n") + steps);
}
