'use strict';
// USB Ethernet: lets the TV use a USB-to-Ethernet adapter as its wired connection. Plain ES5: older TVs run Node 4.4.
//
// Realtek RTL8152/8153/8156 adapters (and their branded versions) get no driver on some Samsung firmwares: the generic
// cdc_ether driver refuses them by their USB id and Realtek's own driver is not loaded. This Shard gives the adapter a
// driver (cdc_ether told the id again, else r8152), then, because Samsung's network services only treat eth0 as "Wired",
// renames the empty built-in port ethb and the adapter eth0, and restarts the services. All of it is lost at a TV restart,
// which is why the Shard does it again after every boot. If the TV gets no address from the adapter, the names go back.
// The commands are in tv.sh (README: Commands it runs). The page can also produce a report, to see why an adapter does not work.

var fs = require('fs');
var path = require('path');

var VERSION = '1.1.0';

// What a finished setup (the last line of tv.sh's log) means for the number of runs this start of Vetro may spend.
var COUNTED = { 'done': true, 'no-address': true, 'rename-failed': true, 'reverted': true, 'no-driver': true };

module.exports = function (ctx) {
    var FIRST_CHECK_MS = 20000;      // Vetro has just started: give the root agent a moment
    var RETRY_MS = 20000;            // the agent is not connected yet
    var POLL_MS = 60000;             // an adapter plugged in later, or a cable moved
    var APPLY_POLL_MS = 3000;        // while a setup runs, how often to ask whether it has finished
    var APPLY_MAX_MS = 180000;       // a setup takes two minutes at the very most
    var MIN_TV_UPTIME_S = 60;        // let Samsung's own network start finish first
    var MAX_APPLIES = 3;             // per Vetro start: never restart the network in a loop
    var REPORT_MS = 30000;

    var timer = null, stopped = false, busy = false, applies = 0, unaddressed = 0, reporting = false;
    var last = { state: 'starting', iface: null, carrier: null, address: null, adapter: null, driver: null, result: null, resultAt: null, error: null };

    function script() { return fs.readFileSync(path.join(ctx.dir, 'tv.sh'), 'utf8'); }
    function b64(text) {
        var hasFrom = typeof Buffer.from === 'function' && Buffer.from !== Uint8Array.from;   // Node 4.4 has only the TypedArray one
        return (hasFrom ? Buffer.from(text, 'utf8') : new Buffer(text, 'utf8')).toString('base64');
    }
    function run(mode) { return 'sh -c "$(echo ' + b64(script()) + ' | base64 -d)" vetro-usb-ethernet ' + mode; }
    function out(r) { return String((r && r.stdout) || '').trim(); }

    function later(ms) {
        if (stopped) return;
        clearTimeout(timer);
        timer = setTimeout(tick, ms);
    }

    function parse(text) {
        var o = {};
        text.split(/\s+/).forEach(function (kv) {
            var i = kv.indexOf('=');
            if (i > 0) o[kv.slice(0, i)] = kv.slice(i + 1);
        });
        return o;
    }

    function check() {
        return ctx.execute(run('check'), 8000).then(function (r) {
            var o = parse(out(r));
            if (!o.state) throw new Error('No answer from the TV');
            return o;
        });
    }

    function remember(o) {
        last.error = null;
        last.state = o.state;
        last.iface = !o.iface || o.iface === '-' ? null : o.iface;
        last.carrier = o.carrier === '1' ? true : o.carrier === '0' ? false : null;
        last.address = o.ip === 'yes' ? true : o.ip === 'no' ? false : null;
        last.adapter = o.adapter || null;
        last.driver = !o.driver || o.driver === '-' ? null : o.driver;
    }

    function readResult() {
        return ctx.execute('tail -n 1 /tmp/vetro-usb-ethernet.log 2>/dev/null', 5000).then(function (r) {
            var m = /^result=([a-z-]+)$/.exec(out(r));
            last.result = m ? m[1] : 'unknown';
            last.resultAt = Date.now();
            return last.result;
        });
    }

    // Starts the setup on the TV, detached (it restarts the network services, which cuts this very connection for a moment),
    // then asks every few seconds whether it has finished, and reads how it ended.
    function apply() {
        last.state = 'applying';
        var started = Date.now();
        var cmd = 'setsid ' + run('apply') + ' >/dev/null 2>&1 </dev/null & echo started';
        function waitDone() {
            if (stopped) return Promise.resolve();
            return new Promise(function (resolve) { setTimeout(resolve, APPLY_POLL_MS); }).then(function () {
                if (stopped) return;
                return check().then(function (o) { return o.state === 'applying'; }, function () { return true; }).then(function (again) {
                    if (again && Date.now() - started < APPLY_MAX_MS) return waitDone();
                });
            });
        }
        return ctx.execute(cmd, 10000).then(waitDone).then(function () {
            if (!stopped) return readResult();
        }).then(function (result) {
            if (result && COUNTED[result]) applies++;
            last.state = 'checking';
        });
    }

    function tick() {
        if (stopped || busy) return;
        busy = true;
        var next = POLL_MS;
        check().then(function (o) {
            remember(o);
            // An adapter plugged in again after the swap comes back as eth0 by itself; if the TV gives it no address
            // in two checks in a row, the network services are restarted for it.
            unaddressed = o.state === 'in-place' && last.carrier === true && last.address === false ? unaddressed + 1 : 0;
            var needs = o.state === 'bind' || o.state === 'swap' || o.state === 'builtin-unknown' || unaddressed >= 2;
            if (!needs) return;
            if (Number(o.up) < MIN_TV_UPTIME_S) { next = RETRY_MS; return; }
            if (applies >= MAX_APPLIES) { last.state = 'gave-up'; return; }
            unaddressed = 0;
            return apply().then(function () { next = 1000; });   // check again right after, to show the new state
        }).catch(function (e) {
            last.error = String(e && e.message || e).slice(0, 200);
            next = RETRY_MS;
        }).then(function () {
            busy = false;
            later(next);
        });
    }

    var page = null;
    function uiPage() {
        if (page) return page;
        var places = [path.join(__dirname, 'ui.html'), path.join(ctx.dir || '', 'ui.html')];
        for (var i = 0; i < places.length; i++) {
            try { page = fs.readFileSync(places[i], 'utf8'); return page; } catch (e) { /* next */ }
        }
        return '<!doctype html><meta charset="utf-8"><p>ui.html is missing from the Shard folder: reinstall this Shard.</p>';
    }

    function json(res, body, code) {
        res.writeHead(code || 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
    }

    // What the person sends along when an adapter does not work: see README, "The report".
    function makeReport() {
        return ctx.execute(run('report'), REPORT_MS).then(function (r) {
            var header = 'USB Ethernet report\nShard version: ' + VERSION + '\nGenerated: ' + new Date().toISOString() + ' (the TV’s clock)\n' +
                'Shard state: ' + JSON.stringify(last) + '\n\n';
            return header + out(r) + '\n';
        });
    }

    return {
        start: function () { stopped = false; applies = 0; unaddressed = 0; later(FIRST_CHECK_MS); },
        // Switching the Shard off changes nothing on the TV: the names and the driver stay as they are until the next restart.
        stop: function () { stopped = true; clearTimeout(timer); timer = null; },
        status: function () { return { state: last.state, result: last.result, error: last.error }; },
        route: function (req, res, sub) {
            if (sub === 'ui' && req.method === 'GET') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(uiPage());
                return true;
            }
            if (sub === 'state' && req.method === 'GET') { json(res, last); return true; }
            if (sub === 'log' && req.method === 'GET') {
                ctx.execute('cat /tmp/vetro-usb-ethernet.log 2>/dev/null', 5000).then(function (r) {
                    json(res, { log: out(r) });
                }).catch(function (e) { json(res, { error: String(e && e.message || e) }, 503); });
                return true;
            }
            if (sub === 'report' && req.method === 'GET') {
                if (reporting) { json(res, { error: 'A report is already being made' }, 409); return true; }
                reporting = true;
                makeReport().then(function (text) {
                    reporting = false;
                    json(res, { text: text });
                }, function (e) {
                    reporting = false;
                    json(res, { error: String(e && e.message || e) }, 503);
                });
                return true;
            }
            return false;
        }
    };
};
module.exports.VERSION = VERSION;
