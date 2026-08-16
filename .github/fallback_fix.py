from pathlib import Path

path = Path('assets/omad/12-app.js')
text = path.read_text()
anchor = """/** An old Apps Script deployment can safely handle the same cart line by line. */
async function submitNewLedgerEntryLegacyFallback_(requestBase, groupId, common) {
"""
replacement = r"""// An old backend treats request ids as opaque strings. If a fallback starts and
// its result becomes uncertain, changing the cart or business fields while
// reusing those ids could duplicate a line or make the browser report success
// for different data than the old backend actually stored. Persist the exact
// fallback submission until it succeeds, including across a browser refresh.
const OMAD_LEGACY_FALLBACK_FINGERPRINT_KEY = 'omad_pending_legacy_fallback_fingerprint';
let omadLegacyFallbackFingerprint_ = '';

function legacyFallbackFingerprint_(requestBase, groupId, common) {
    return JSON.stringify({
        requestId: String(requestBase || ''),
        groupId: String(groupId || ''),
        tenant: String((common && common.tenant) || ''),
        period: String((common && common.period) || ''),
        type: String((common && common.type) || ''),
        comment: String((common && common.comment) || ''),
        source: String((common && common.source) || ''),
        createdBy: String((common && common.createdBy) || ''),
        lines: cart.map(item => ({
            amount: Number(item.amount) || 0,
            currency: String(item.currency || ''),
            method: String(item.method || '')
        }))
    });
}

function assertLegacyFallbackSubmissionUnchanged_(requestBase, groupId, common) {
    const fingerprint = legacyFallbackFingerprint_(requestBase, groupId, common);
    if(!omadLegacyFallbackFingerprint_) {
        try {
            omadLegacyFallbackFingerprint_ = sessionStorage.getItem(OMAD_LEGACY_FALLBACK_FINGERPRINT_KEY) || '';
        } catch (e) { omadLegacyFallbackFingerprint_ = ''; }
    }
    if(omadLegacyFallbackFingerprint_ && omadLegacyFallbackFingerprint_ !== fingerprint) {
        throw new Error(
            "Oldingi saqlash urinishining natijasi noma'lum. Dublikat bo'lmasligi uchun ma'lumotni o'zgartirmang; asl holatini tiklab qayta urinib ko'ring."
        );
    }
    if(!omadLegacyFallbackFingerprint_) {
        omadLegacyFallbackFingerprint_ = fingerprint;
        try { sessionStorage.setItem(OMAD_LEGACY_FALLBACK_FINGERPRINT_KEY, fingerprint); } catch (e) {}
    }
}

// Successful saves and explicit form resets already clear the pending request;
// clear the fallback fingerprint at exactly the same boundary.
var clearPendingRequestBeforeLegacyFallbackGuard_ = clearPendingRequest;
clearPendingRequest = function() {
    omadLegacyFallbackFingerprint_ = '';
    try { sessionStorage.removeItem(OMAD_LEGACY_FALLBACK_FINGERPRINT_KEY); } catch (e) {}
    return clearPendingRequestBeforeLegacyFallbackGuard_();
};

/** An old Apps Script deployment can safely handle the same unchanged cart line by line. */
async function submitNewLedgerEntryLegacyFallback_(requestBase, groupId, common) {
    assertLegacyFallbackSubmissionUnchanged_(requestBase, groupId, common);
"""
if anchor not in text:
    raise SystemExit('legacy fallback anchor missing')
path.write_text(text.replace(anchor, replacement, 1))

path = Path('tests/omad-ledger.e2e.js')
text = path.read_text()
marker = "  // --------------------------------------------------------------- correct\n"
if marker not in text:
    raise SystemExit('e2e fallback insertion anchor missing')
added = r"""  test('an uncertain old-backend fallback refuses a changed cart before another line write', async () => {
    let createAttempts = 0;
    const { page, context, requests } = await openAdmin({
      respond: payload => {
        if (payload.action === 'create_transaction_batch') {
          return { status: 'error', message: 'Unknown action: create_transaction_batch' };
        }
        if (payload.action === 'create_transaction') {
          createAttempts++;
          if (createAttempts === 1) return { status: 'error', message: 'connection lost' };
          return { status: 'success', transaction: {} };
        }
        return null;
      }
    });

    await fillEntry(page);
    await page.evaluate(() => submitAll());
    const firstCreate = requests.filter(r => r.action === 'create_transaction')[0];
    assert.ok(firstCreate, 'the first fallback reaches the old single-row API');

    await page.evaluate(() => {
      cart[0].amount = Number(cart[0].amount) + 1;
      renderCart();
    });
    await page.evaluate(() => submitAll());

    assert.strictEqual(requests.filter(r => r.action === 'create_transaction_batch').length, 2,
      'the harmless capability probe can repeat');
    assert.strictEqual(requests.filter(r => r.action === 'create_transaction').length, 1,
      'changed data never reaches the opaque old single-row idempotency API');
    const stored = await page.evaluate(() => sessionStorage.getItem('omad_pending_legacy_fallback_fingerprint'));
    assert.ok(stored, 'the uncertain fallback shape stays pinned for a safe retry');
    await context.close();
  });

  test('an uncertain old-backend fallback can retry the exact same submission', async () => {
    let createAttempts = 0;
    const { page, context, requests } = await openAdmin({
      respond: payload => {
        if (payload.action === 'create_transaction_batch') {
          return { status: 'error', message: 'Unknown action: create_transaction_batch' };
        }
        if (payload.action === 'create_transaction') {
          createAttempts++;
          if (createAttempts === 1) return { status: 'error', message: 'connection lost' };
          return { status: 'success', transaction: {} };
        }
        return null;
      }
    });

    await fillEntry(page);
    await page.evaluate(() => submitAll());
    await page.evaluate(() => submitAll());

    const creates = requests.filter(r => r.action === 'create_transaction');
    assert.strictEqual(creates.length, 2);
    assert.strictEqual(creates[0].requestId, creates[1].requestId,
      'the exact retry uses the same opaque id on the old backend');
    const stored = await page.evaluate(() => sessionStorage.getItem('omad_pending_legacy_fallback_fingerprint'));
    assert.strictEqual(stored, null, 'a successful retry clears the fallback fingerprint');
    await context.close();
  });

"""
path.write_text(text.replace(marker, added + marker, 1))

path = Path('docs/ARCHITECTURE.md')
text = path.read_text()
old = """Older uncounted
`<requestBase>_<index>` rows are accepted as a duplicate only when the full
requested set already exists; an ambiguous partial legacy set fails closed.
The batch also freezes one buy/sell rate pair for the whole business action; a
partial resume inherits the first stored line's pair, and inconsistent existing
snapshots are refused rather than mixed.
"""
new = """Older uncounted
`<requestBase>_<index>` rows are accepted as a duplicate only when the full
requested set already exists; an ambiguous partial legacy set fails closed. If
the browser has fallen back to an **older backend** that treats those ids as
opaque strings, it persists the exact fallback submission in `sessionStorage`
and refuses a changed cart/business payload until that uncertain retry is
resolved; otherwise an old server could not distinguish a modified request.
The batch also freezes one buy/sell rate pair for the whole business action; a
partial resume inherits the first stored line's pair, and inconsistent existing
snapshots are refused rather than mixed.
"""
if old not in text:
    raise SystemExit('architecture rollout paragraph anchor missing')
path.write_text(text.replace(old, new, 1))
