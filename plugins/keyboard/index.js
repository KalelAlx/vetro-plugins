'use strict';

// Vetro Shard: Keyboard & Remote
//
// Dual input architecture:
//   1. Navigation, control keys & ASCII typing: executed directly on the TV via
//      /usr/bin/input_keyevent (ctx.execute).
//   2. Full Unicode (all languages): sent via Samsung Remote API WebSocket
//      (wss://<tvIp>:8002) directly from the browser using pre-paired token.
//
// Continuous Key Repeat:
//   - WebSocket mode: uses Samsung Remote "Press" and "Release" commands.
//   - HTTP mode: TV-side hold timer (75ms) triggered by action: "down" / "up",
//     eliminating network congestion.

var fs = require('fs');
var path = require('path');

var LATIN_MAP = {
    ' ': 'space',
    '.': 'period',
    ',': 'comma',
    '-': 'minus',
    '_': 'underscore',
    '/': 'slash',
    ':': 'colon',
    ';': 'semicolon',
    '@': 'at',
    '?': 'question',
    '!': 'exclam',
    '+': 'plus',
    '=': 'equal',
    '*': 'asterisk',
    '(': 'parenleft',
    ')': 'parenright',
    '[': 'bracketleft',
    ']': 'bracketright'
};

function charToKey(ch) {
    if (/^[a-zA-Z0-9]$/.test(ch)) return ch;
    if (LATIN_MAP[ch]) return LATIN_MAP[ch];
    return null;
}

function loadPage(ctx) {
    var places = [path.join(__dirname, 'ui.html'), path.join(ctx.dir || '', 'ui.html')];
    for (var i = 0; i < places.length; i++) {
        try { return fs.readFileSync(places[i], 'utf8'); } catch (e) { /* next */ }
    }
    return '<!doctype html><meta charset="utf-8"><p>Page file missing: reinstall this Shard.</p>';
}

module.exports = function (ctx) {

    var page = null;
    var activeHoldTimer = null;
    var activeHoldKey = null;

    function stopHold() {
        if (activeHoldTimer) {
            clearInterval(activeHoldTimer);
            activeHoldTimer = null;
        }
        if (activeHoldKey) {
            ctx.execute('/usr/bin/input_keyevent ' + activeHoldKey + ' up', 2000).catch(function () {});
            activeHoldKey = null;
        }
    }

    function startHold(key) {
        stopHold();
        activeHoldKey = key;
        ctx.execute('/usr/bin/input_keyevent ' + key + ' down', 2000).catch(function () {});

        var started = Date.now();
        activeHoldTimer = setInterval(function () {
            if (Date.now() - started > 6000 || activeHoldKey !== key) {
                stopHold();
                return;
            }
            ctx.execute('/usr/bin/input_keyevent ' + key, 2000).catch(function () {});
        }, 75);
    }

    function getCfg() {
        var c = ctx.config.get();
        return (c && typeof c === 'object') ? c : {};
    }

    function saveCfg(c) {
        ctx.config.set(c);
    }

    return {
        start: function () {
            page = loadPage(ctx);
        },

        stop: function () {
            stopHold();
            page = null;
        },

        status: function () {
            var cfg = getCfg();
            return { token: cfg.token || null };
        },

        route: function (req, res, sub) {

            // GET api/ui
            if (sub === 'ui' && req.method === 'GET') {
                if (!page) page = loadPage(ctx);
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(page || '');
                return true;
            }

            // GET api/status
            if (sub === 'status' && req.method === 'GET') {
                var cfg0 = getCfg();
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: true, token: cfg0.token || null }));
                return true;
            }

            // POST api/savetoken
            if (sub === 'savetoken' && req.method === 'POST') {
                var b = '';
                req.on('data', function (c) { b += c; });
                req.on('end', function () {
                    var parsed;
                    try { parsed = JSON.parse(b); } catch (e) { parsed = {}; }
                    var c2 = getCfg();
                    if (parsed.token) {
                        c2.token = String(parsed.token);
                    } else if (parsed.reset || parsed.token === null) {
                        delete c2.token;
                    }
                    saveCfg(c2);
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                });
                return true;
            }

            // POST api/key — inject single keysym or manage hold action
            if (sub === 'key' && req.method === 'POST') {
                var body = '';
                req.on('data', function (c) { body += c; });
                req.on('end', function () {
                    var parsed, key, action;
                    try {
                        parsed = JSON.parse(body);
                        key = parsed.key;
                        action = parsed.action;
                    } catch (e) {
                        key = null;
                        action = null;
                    }
                    if (!key || typeof key !== 'string' || !/^[A-Za-z0-9_]+$/.test(key)) {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'invalid key name' }));
                        return;
                    }

                    if (action === 'down') {
                        startHold(key);
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: true, holding: true }));
                        return;
                    }

                    if (action === 'up') {
                        stopHold();
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: true, holding: false }));
                        return;
                    }

                    // Single tap / click
                    stopHold();
                    ctx.execute('/usr/bin/input_keyevent ' + key, 5000)
                        .then(function (r) {
                            res.writeHead(200, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: r.exit_code === 0, stderr: r.stderr }));
                        })
                        .catch(function (e) {
                            res.writeHead(200, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: e.message }));
                        });
                });
                return true;
            }

            // POST api/type — inject ASCII string via input_keyevent sequence
            if (sub === 'type' && req.method === 'POST') {
                var btype = '';
                req.on('data', function (c) { btype += c; });
                req.on('end', function () {
                    var parsed, text;
                    try { parsed = JSON.parse(btype); text = parsed.text; } catch (e) { text = null; }
                    if (!text || typeof text !== 'string') {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'missing text' }));
                        return;
                    }
                    var keys = [];
                    for (var i = 0; i < text.length; i++) {
                        var k = charToKey(text[i]);
                        if (k) keys.push(k);
                    }
                    if (keys.length === 0) {
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: true }));
                        return;
                    }
                    var cmd = "sh -c 'for k in " + keys.join(' ') + "; do /usr/bin/input_keyevent \"$k\"; sleep 0.04; done'";
                    ctx.execute(cmd, 15000)
                        .then(function (r) {
                            res.writeHead(200, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: r.exit_code === 0, stderr: r.stderr }));
                        })
                        .catch(function (e) {
                            res.writeHead(200, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: e.message }));
                        });
                });
                return true;
            }

            // GET api/screenshot — captures 1080p frame buffer from Enlightenment WM
            if (sub === 'screenshot' && req.method === 'GET') {
                var shotPath = '/tmp/screenshot.png';
                var shotCmd = "dbus-send --system --print-reply --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.info.dump_screen string:'" + shotPath + "'";
                ctx.execute(shotCmd, 10000)
                    .then(function (r) {
                        if (r.exit_code !== 0) {
                            res.writeHead(500, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: r.stderr || 'Screenshot capture failed' }));
                            return;
                        }
                        fs.readFile(shotPath, function (err, data) {
                            if (err) {
                                res.writeHead(500, { 'content-type': 'application/json' });
                                res.end(JSON.stringify({ ok: false, error: err.message }));
                                return;
                            }
                            res.writeHead(200, {
                                'content-type': 'image/png',
                                'cache-control': 'no-store, must-revalidate',
                                'content-length': data.length
                            });
                            res.end(data);
                        });
                    })
                    .catch(function (e) {
                        res.writeHead(500, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: e.message }));
                    });
                return true;
            }

            return false;
        }
    };
};
