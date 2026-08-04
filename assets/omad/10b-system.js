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

function systemAdminKey() {
    const input = document.getElementById('tgAdminKey');
    return input ? input.value.trim() : "";
}

function requireAdminKey() {
    const key = systemAdminKey();
    if (!key) {
        alert("Admin kalitini kiriting (Telegram bo'limida).");
        return "";
    }
    return key;
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
    const adminKey = requireAdminKey();
    if (!adminKey) return;

    showLoader(true);
    try {
        const data = await callBackend({ action: 'create_backup', adminKey });
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
    const adminKey = requireAdminKey();
    if (!adminKey) return;

    showLoader(true);
    try {
        const data = await callBackend({ action: 'process_jobs', adminKey });
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
    const adminKey = requireAdminKey();
    if (!adminKey) return;

    showLoader(true);
    try {
        const data = await callBackend({ action: 'retry_failed_jobs', adminKey });
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
    const adminKey = requireAdminKey();
    if (!adminKey) return null;
    if (confirmText && !confirm(confirmText)) return null;

    showLoader(true);
    try {
        return await callBackend({ action, adminKey, fallbackYear: selectedFallbackYear() });
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
