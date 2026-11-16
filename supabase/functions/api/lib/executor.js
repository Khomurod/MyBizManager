// The replay executor: synchronous backend code over asynchronous I/O.
//
// The backend (apps-script/*.gs) was written for Apps Script, where
// UrlFetchApp.fetch blocks until the answer is back. In Deno every network
// call returns a promise, and nothing can block on one. Rewriting thousands of
// lines of synchronous business code as async would be a second application,
// which is exactly what this project refuses to have.
//
// So a request is run, from the top, as many times as it needs I/O:
//
//   1. Run the request. Every I/O it asks for that is already on the tape is
//      answered from the tape.
//   2. The first I/O that is not on the tape stops the run: the shim throws a
//      ReplayPending signal. Nothing has been sent anywhere -- shims never do
//      real I/O during a run.
//   3. Do that one I/O for real, append the answer to the tape, and go to 1.
//   4. A run that finishes without asking for anything new is the answer.
//
// Each I/O therefore happens exactly once and in the order the code asked for
// it, which is what Apps Script did. The other inputs a run can differ on --
// the clock, random numbers, UUIDs -- are recorded on the same tape, so every
// run takes the path the first one took. A run that asks for something other
// than what the tape holds at that position has diverged; that is a bug, and
// the request fails rather than guess.
//
// The backend's own try/catch blocks may catch the signal. That is harmless:
// once a run is pending, every further I/O it attempts throws again without
// being recorded, and the run's result is discarded.
//
// Deferred I/O (a cache write, say) is an I/O whose answer the code does not
// read. It is queued instead of stopping the run, and sent alongside the next
// real I/O or when the request finishes.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MBMExecutor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PENDING_MESSAGE = 'MBM_REPLAY_PENDING';

  /** What a shim throws to stop a run that needs I/O. An Error, so any catch block can print it. */
  function ReplayPending() {
    var error = new Error(PENDING_MESSAGE);
    error.name = 'ReplayPending';
    error.__mbmReplayPending = true;
    return error;
  }

  function divergence(message) {
    var error = new Error('Replay diverged: ' + message);
    error.__mbmDivergence = true;
    return error;
  }

  function createTape() {
    return { io: [], nd: [], deferred: [], runs: 0 };
  }

  /**
   * The per-run view of the tape that the shims talk to.
   *
   *   ctx.io(key, request)        an answer, or throws ReplayPending
   *   ctx.nd(kind, produce)       a recorded value (clock, uuid, random)
   *   ctx.defer(key, request)     queue an I/O whose answer is not needed
   */
  function createRunContext(tape) {
    var ctx = {
      ioAt: 0,
      ndAt: 0,
      deferAt: 0,
      pending: null,
      pendingNd: 0,
      pendingDefer: 0
    };

    ctx.io = function (key, request) {
      if (ctx.pending) throw ReplayPending();
      if (ctx.ioAt < tape.io.length) {
        var entry = tape.io[ctx.ioAt];
        if (entry.key !== key) {
          throw divergence('I/O #' + ctx.ioAt + ' was ' + describeKey(entry.key) + ', now ' + describeKey(key));
        }
        ctx.ioAt++;
        return entry.response;
      }
      ctx.pending = { key: key, request: request };
      ctx.pendingNd = ctx.ndAt;
      ctx.pendingDefer = ctx.deferAt;
      throw ReplayPending();
    };

    ctx.nd = function (kind, produce) {
      if (ctx.ndAt < tape.nd.length) {
        var entry = tape.nd[ctx.ndAt];
        if (entry.kind !== kind) throw divergence('value #' + ctx.ndAt + ' was a ' + entry.kind + ', now a ' + kind);
        ctx.ndAt++;
        return entry.value;
      }
      var value = produce();
      tape.nd.push({ kind: kind, value: value });
      ctx.ndAt++;
      return value;
    };

    ctx.defer = function (key, request) {
      if (ctx.pending) return;
      if (ctx.deferAt < tape.deferred.length) {
        var entry = tape.deferred[ctx.deferAt];
        if (entry.key !== key) {
          throw divergence('deferred #' + ctx.deferAt + ' was ' + describeKey(entry.key) + ', now ' + describeKey(key));
        }
        ctx.deferAt++;
        return;
      }
      tape.deferred.push({ key: key, request: request, sent: false });
      ctx.deferAt++;
    };

    return ctx;
  }

  /**
   * Text that may hold a URL, without the URL's secret parts: the bot token
   * (/bot<token>/) and the webhook secret or a key in the query. A failed fetch
   * names its URL, so every error that is logged or handed back goes through
   * this first.
   */
  function redact(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/\/bot[^/\s)'"]+/g, '/bot[REDACTED]')
      .replace(/([?&](?:wh|apikey|key|token|secret|cronSecret)=)[^&\s)'"]*/gi, '$1[REDACTED]');
  }

  /** Enough of a key to debug a divergence, never a URL's secret part. */
  function describeKey(key) {
    var text = String(key || '');
    var line = text.split('\n')[0];
    return redact(line).slice(0, 160);
  }

  /**
   * One run. Returns { pending } when it stopped for I/O, otherwise
   * { result } or { error } for what the code itself returned or threw.
   */
  function runOnce(tape, makeGlobals, invoke) {
    var ctx = createRunContext(tape);
    tape.runs++;
    var outcome = {};
    try {
      outcome.result = invoke(makeGlobals(ctx), ctx);
    } catch (error) {
      if (error && error.__mbmDivergence) throw error;
      outcome.error = error;
    }
    if (ctx.pending) {
      // Values drawn after the I/O point belonged to a path that no longer
      // exists once the answer is known; the next run draws its own.
      tape.nd.length = ctx.pendingNd;
      tape.deferred.length = Math.max(ctx.pendingDefer, countSent(tape.deferred));
      return { pending: ctx.pending };
    }
    if (outcome.error && outcome.error.__mbmReplayPending) {
      throw divergence('a run threw the replay signal without a pending I/O');
    }
    if (ctx.ioAt !== tape.io.length) {
      throw divergence('the tape holds ' + tape.io.length + ' I/O answers but the run used ' + ctx.ioAt);
    }
    if (ctx.deferAt !== tape.deferred.length) {
      throw divergence('the tape holds ' + tape.deferred.length + ' deferred I/O but the run queued ' + ctx.deferAt);
    }
    return outcome;
  }

  function countSent(deferred) {
    var n = 0;
    while (n < deferred.length && deferred[n].sent) n++;
    return n;
  }

  function unsentDeferred(tape) {
    return tape.deferred.filter(function (entry) { return !entry.sent; });
  }

  /**
   * Runs `invoke` to completion.
   *
   * options:
   *   makeGlobals(ctx)   the Apps Script globals for one run (gas-shims.js)
   *   invoke(G, ctx)     calls the entry point, e.g. G.runtime.doPost(event)
   *   perform(request)   does one I/O for real; may return a promise
   *   performDeferred(requests)  sends queued deferred I/O; may return a promise
   *   maxRuns            refuses to go on past this many runs (default 120)
   *
   * Resolves to { result } or { error } exactly as the code produced them,
   * plus `runs` and `ios`.
   */
  async function run(options) {
    var tape = options.tape || createTape();
    var maxRuns = options.maxRuns || 120;
    for (;;) {
      if (tape.runs >= maxRuns) throw new Error('Replay: more than ' + maxRuns + ' runs for one request');
      var step = runOnce(tape, options.makeGlobals, options.invoke);
      if (!step.pending) {
        await sendDeferred(tape, options);
        step.runs = tape.runs;
        step.ios = tape.io.length;
        return step;
      }
      var deferredNow = sendDeferred(tape, options);
      var answer = options.perform(step.pending.request);
      var settled = await Promise.all([answer, deferredNow]);
      tape.io.push({ key: step.pending.key, response: settled[0] });
    }
  }

  /** The same loop for a synchronous `perform` (the test harness's in-memory database). */
  function runSync(options) {
    var tape = options.tape || createTape();
    var maxRuns = options.maxRuns || 120;
    for (;;) {
      if (tape.runs >= maxRuns) throw new Error('Replay: more than ' + maxRuns + ' runs for one request');
      var step = runOnce(tape, options.makeGlobals, options.invoke);
      sendDeferredSync(tape, options);
      if (!step.pending) {
        step.runs = tape.runs;
        step.ios = tape.io.length;
        return step;
      }
      tape.io.push({ key: step.pending.key, response: options.perform(step.pending.request) });
    }
  }

  function sendDeferred(tape, options) {
    var queued = unsentDeferred(tape);
    if (!queued.length || !options.performDeferred) return Promise.resolve();
    queued.forEach(function (entry) { entry.sent = true; });
    return Promise.resolve(options.performDeferred(queued.map(function (entry) { return entry.request; })))
      .catch(function () { /* a lost cache write costs a cache miss, never a wrong answer */ });
  }

  function sendDeferredSync(tape, options) {
    var queued = unsentDeferred(tape);
    if (!queued.length || !options.performDeferred) return;
    queued.forEach(function (entry) { entry.sent = true; });
    try { options.performDeferred(queued.map(function (entry) { return entry.request; })); } catch (error) {}
  }

  /**
   * Owners of database leases (the script lock, app_lease) a finished request
   * took and did not give back -- a run that failed between the lock and its
   * release. The caller releases them, so the next request does not wait out
   * the lease's expiry. Read from the tape, which holds every call and answer.
   */
  function leasesLeftHeld(tape) {
    var held = [];
    var ok = function (response) { return !!response && response.code >= 200 && response.code < 300; };
    tape.io.forEach(function (entry) {
      var key = String(entry.key);
      var newline = key.indexOf('\n');
      var head = newline === -1 ? key : key.slice(0, newline);
      if (/^POST \S+\/rest\/v1\/rpc\/mbm_lock$/.test(head)) {
        var body = {};
        var answer = {};
        try { body = JSON.parse(key.slice(newline + 1)); } catch (error) { body = {}; }
        try { answer = JSON.parse(entry.response && entry.response.text || '{}'); } catch (error) { answer = {}; }
        if (ok(entry.response) && answer && answer.acquired === true && body.p_owner && held.indexOf(body.p_owner) === -1) {
          held.push(String(body.p_owner));
        }
        return;
      }
      if (!ok(entry.response)) return;
      held = held.filter(function (owner) {
        var inBatch = key.indexOf('"op":"unlock","owner":' + JSON.stringify(owner)) !== -1;
        var direct = /\/rest\/v1\/rpc\/mbm_unlock$/.test(head) && key.indexOf('"p_owner":' + JSON.stringify(owner)) !== -1;
        return !(inBatch || direct);
      });
    });
    return held;
  }

  return {
    leasesLeftHeld: leasesLeftHeld,
    PENDING_MESSAGE: PENDING_MESSAGE,
    ReplayPending: ReplayPending,
    createTape: createTape,
    createRunContext: createRunContext,
    run: run,
    runSync: runSync,
    describeKey: describeKey,
    redact: redact
  };
});
