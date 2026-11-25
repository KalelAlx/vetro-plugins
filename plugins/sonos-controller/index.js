'use strict';
// Sonos controller: a Vetro Shard that turns remote-control key presses into Sonos volume and mute.
//
//   remote key -> Vetro remapper rule "Publish MQTT message" -> this Shard's MQTT receiver (127.0.0.1)
//              -> SOAP request to the Sonos speaker on the LAN (port 1400)
//
// Vetro gives a Shard no way to see key presses, but its rules can publish an MQTT message for a key, and
// its MQTT link can point at any broker. This Shard is that broker, cut down to receiving.
// Command topics: <prefix>/volume-up, volume-down, mute-toggle, mute, unmute (prefix vetro/sonos by default).
//
// Plain ES5, as the Vetro Shard guide asks (older TVs run Node 4.4). Every socket, timer and promise here
// handles its own errors: Vetro only guards start/stop/status/route, and an uncaught error elsewhere
// would stop the Shard or the whole Vetro service.

var fs = require('fs');
var path = require('path');
var Receiver = require('./mqtt-receiver.js').Receiver;
var sonos = require('./sonos.js');
var discovery = require('./discovery.js');
var vetroCheck = require('./vetro-check.js');
var cardLayout = require('./card-layout.js');

var VERSION = '0.3.1';
var ACTIONS = ['volume-up', 'volume-down', 'mute-toggle', 'mute', 'unmute'];
var DEFAULTS = {
    speaker: null,            // { uuid, name, address } of the room the remote controls
    target: 'group',          // 'group': every room grouped with it (just the room when it is alone); 'room': that room only
    step: 3,                  // volume change per key press (Sonos scale 0-100)
    maxVolume: 100,           // volume up stops here; 100 = no limit
    unmuteOnVolume: true,     // a volume key also unmutes, like a TV
    brokerPort: 1883,         // where Vetro's MQTT link connects (127.0.0.1)
    topicPrefix: 'vetro/sonos',
    username: '',             // optional: require this user name and password from Vetro
    password: ''
};
var PREFIX_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
var KEY_NAMES = { 'volume-up': 'Volume up', 'volume-down': 'Volume down', 'mute-toggle': 'Mute', 'mute': 'Mute only', 'unmute': 'Unmute' };
var REQUIRED = ['volume-up', 'volume-down', 'mute-toggle'];
var UUID_RE = /^[A-Za-z0-9_:.-]{1,80}$/;
var MAX_QUEUE = 16, MAX_LOG = 40, MAX_BODY = 16384, TOPOLOGY_TTL_MS = 30000;
var STALE_MS = 3000;          // a key press still waiting after this long is dropped, not applied late
var LOOKUP_TIMEOUT_MS = 2500, SEARCH_WINDOW_MS = 2500;
var MEMBER_READ_MS = 1500;    // each grouped room's own volume and mute (read side by side)
// The Control center card (Vetro 0.7.0, manifest "controlCenter"). Vetro gives card() 3 seconds and cardSelect() 10.
var CARD_READ_MS = 1200;      // each speaker read while the card is drawn (they run side by side)
var CARD_TOPOLOGY_MS = 2000;  // reading the rooms and groups for a change
var CARD_CHANGE_MS = 3000;    // the grouping command itself
var CARD_SETTLE_MS = 2500;    // waiting for the speakers to report the new grouping
var CARD_SELECT_MS = 8000;    // the whole press, under Vetro's 10 seconds
var CARD_RESERVE_MS = 2600;   // what reading the card once more can take (topology and volumes, 1.2 s each)
var CARD_ROWS = 7;            // Vetro shows at most 7 rows: the TV speaker and 6 other rooms
var CARD_TOPOLOGY_AGE_MS = 5000;  // the card reuses a reading of the rooms this recent (a change in the Sonos app shows soon)
var CARD_ANSWER_MS = 300;     // what answering a press without asking a speaker takes, kept free of the limit
var CARD_NOTE_MAX = 33;       // Vetro allows 80, but the launcher's header shows about 33 characters (2022 The Frame)
var CARD_LABEL_MAX = 40;      // Vetro's limit for a row
// A row is one line of text in a proportional font ("label · value" when there is a value), so the card puts
// the marks first: a filled circle for a room that plays the TV sound, an empty one for a room that does not,
// then the volume, then the room name. The space before the volume is made of space characters of known widths
// in the TV's font (card-layout.js), so that every name starts in the same column.
var DOT_ON = '\u25CF', DOT_OFF = '\u25CB', MUTED = '\u2013';

function noop() {}

function isInt(v, min, max) {
    return typeof v === 'number' && v === Math.floor(v) && v >= min && v <= max;
}

// Merges an update into the previous settings. Throws an Error whose message is shown to the user.
function validateSettings(input, previous) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings must be an object');
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) { out[k] = previous[k]; });
    function has(k) { return Object.prototype.hasOwnProperty.call(input, k); }

    if (has('speaker')) {
        var s = input.speaker;
        if (s === null) out.speaker = null;
        else {
            if (!s || typeof s !== 'object') throw new Error('Choose a speaker');
            // Only a home-network address (sonos.parseAddress says why not, for the page).
            var address = sonos.formatAddress(sonos.parseAddress(s.address));
            if (s.uuid != null && (typeof s.uuid !== 'string' || !UUID_RE.test(s.uuid))) throw new Error('Invalid speaker id');
            if (s.name != null && (typeof s.name !== 'string' || s.name.length > sonos.MAX_NAME)) throw new Error('Invalid speaker name');
            // No name: show the address (an IPv4 address, so always shorter than a room name can be).
            out.speaker = { uuid: s.uuid || null, name: s.name || address, address: address };
        }
    }
    if (has('target')) {
        if (input.target !== 'room' && input.target !== 'group') throw new Error('Target must be room or group');
        out.target = input.target;
    }
    if (has('step')) {
        if (!isInt(input.step, 1, 10)) throw new Error('Step must be a whole number from 1 to 10');
        out.step = input.step;
    }
    if (has('maxVolume')) {
        if (!isInt(input.maxVolume, 1, 100)) throw new Error('Maximum volume must be a whole number from 1 to 100');
        out.maxVolume = input.maxVolume;
    }
    if (has('unmuteOnVolume')) {
        if (typeof input.unmuteOnVolume !== 'boolean') throw new Error('unmuteOnVolume must be true or false');
        out.unmuteOnVolume = input.unmuteOnVolume;
    }
    if (has('brokerPort')) {
        if (!isInt(input.brokerPort, 1, 65535)) throw new Error('Port must be a whole number from 1 to 65535');
        out.brokerPort = input.brokerPort;
    }
    if (has('topicPrefix')) {
        if (typeof input.topicPrefix !== 'string' || input.topicPrefix.length > 100 || !PREFIX_RE.test(input.topicPrefix)) {
            throw new Error('Topic prefix: letters, digits, . _ - and / between levels, up to 100 characters');
        }
        out.topicPrefix = input.topicPrefix;
    }
    if (has('username')) {
        if (typeof input.username !== 'string' || input.username.length > 64) throw new Error('User name: up to 64 characters');
        out.username = input.username;
    }
    if (has('password')) {
        if (typeof input.password !== 'string' || input.password.length > 128) throw new Error('Password: up to 128 characters');
        out.password = input.password;
    }
    if (!out.username) out.password = '';
    return out;
}

// What is saved may be from an older version or edited by hand: keep what is valid, default the rest.
// onDropped(key, error), if given, hears about each saved value that was not valid. A speaker saved by
// an older version with an address outside the home network is dropped this way (see sonos.js).
function normalize(stored, onDropped) {
    var out = validateSettings({}, DEFAULTS);
    if (!stored || typeof stored !== 'object') return out;
    Object.keys(DEFAULTS).forEach(function (k) {
        if (!Object.prototype.hasOwnProperty.call(stored, k)) return;
        var one = {};
        one[k] = stored[k];
        // Versions up to 0.2.4 could save a room name longer than the settings check allows (a Sonos room
        // renamed to a long name): shorten it, as the room list now does, instead of losing the speaker.
        var sp = stored[k];
        if (k === 'speaker' && sp && typeof sp === 'object' && typeof sp.name === 'string' && sp.name.length > sonos.MAX_NAME) {
            one.speaker = { uuid: sp.uuid, name: sonos.shortName(sp.name), address: sp.address };
        }
        try { out = validateSettings(one, out); } catch (e) { if (onDropped) onDropped(k, e); }
    });
    return out;
}

function publicSettings(cfg) {
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) { if (k !== 'password') out[k] = cfg[k]; });
    out.hasPassword = !!cfg.password;
    return out;
}

function isVolume(action) { return action === 'volume-up' || action === 'volume-down'; }

function unique(list) {
    var seen = {}, out = [];
    list.forEach(function (x) { if (x && !seen[x]) { seen[x] = true; out.push(x); } });
    return out;
}

function createShard(ctx) {
    var cfg = normalize(null);
    var running = false, receiver = null, search = null;
    var queue = [], busy = false;
    var topo = null;                       // { at, data } from the last GetZoneGroupState
    var log = [];
    var state = { volume: null, muted: null, readAt: null, lastCommand: null, lastError: null, addressRefused: false, commands: 0 };
    var group = null;                      // [{ uuid, name, volume, muted }]: the rooms grouped with the chosen one, while it is grouped
    var speakerProblem = null;             // why the saved speaker was not loaded, until one is chosen
    var remote = { presses: 0, lastAt: null, lastTopic: null, ignored: 0, lastIgnored: null };
    var lastCheck = null, checking = null;

    function note(level, text) {
        log.push({ at: Date.now(), level: level, text: String(text).slice(0, 300) });
        if (log.length > MAX_LOG) log.shift();
    }

    function save() {
        try { ctx.config.set(cfg); } catch (e) { note('error', 'Could not save the settings: ' + e.message); }
    }

    // ---- MQTT receiver -------------------------------------------------------------------------------

    function startReceiver() {
        stopReceiver();
        receiver = new Receiver({
            port: cfg.brokerPort,
            host: '127.0.0.1',
            username: cfg.username || null,
            password: cfg.password || null,
            onMessage: onMessage,
            onEvent: function (type, text) { note(type === 'error' ? 'error' : 'info', text); }
        });
        receiver.start();
    }

    function stopReceiver() {
        if (receiver) receiver.stop();
        receiver = null;
    }

    // Vetro's own traffic: telemetry and availability under <prefix>/<its client id>/..., and Home Assistant
    // discovery records. Everything else that is not a command is most likely a mistyped rule topic: say so.
    function isVetroTraffic(msg) {
        if (msg.topic.indexOf('homeassistant/') === 0) return true;
        var identity = encodeURIComponent(msg.clientId || '').replace(/%/g, '_');
        var parts = msg.topic.split('/');
        return !!identity && parts.length >= 3 && parts[1] === identity;
    }

    function ignore(msg, why) {
        remote.ignored++;
        remote.lastIgnored = { topic: msg.topic, at: Date.now(), why: why };
        note('warn', 'Ignored a message on ' + msg.topic + ': ' + why);
    }

    function onMessage(msg) {
        var prefix = cfg.topicPrefix + '/';
        if (msg.topic.indexOf(prefix) !== 0) {
            if (!isVetroTraffic(msg)) ignore(msg, 'not a command topic (they start with ' + prefix + ')');
            return;
        }
        var action = msg.topic.slice(prefix.length);
        if (ACTIONS.indexOf(action) < 0) { ignore(msg, 'unknown command'); return; }
        if (msg.retained) { ignore(msg, 'retained messages are not key presses'); return; }
        remote.presses++;
        remote.lastAt = Date.now();
        remote.lastTopic = msg.topic;
        enqueue(action, 'remote');
    }

    // ---- Finding the speaker -------------------------------------------------------------------------

    // Asks each address in turn; resolves to { at, data, from } for the first that answers, or null.
    function firstTopology(addresses) {
        var i = 0;
        function next() {
            if (i >= addresses.length) return Promise.resolve(null);
            var text = addresses[i++], address;
            try { address = sonos.parseAddress(text); } catch (e) { return next(); }
            return sonos.getTopology(address, LOOKUP_TIMEOUT_MS).then(function (data) {
                return { at: Date.now(), data: data, from: text };
            }, function () { return next(); });
        }
        return next();
    }

    // -> { addresses: ['host[:port]'], rejected: [{ address, why, error }] }. Answers from addresses outside
    // the home network are never asked anything; they are logged and returned for the page.
    function discoverAddresses() {
        if (search) search.cancel();
        var mine = discovery.search(SEARCH_WINDOW_MS);
        search = mine;
        return mine.promise.then(function (result) {
            if (search === mine) search = null;
            result.rejected.forEach(function (r) { note('warn', 'Search: not using the answer from ' + r.error); });
            return { addresses: result.found.map(sonos.formatAddress), rejected: result.rejected };
        });
    }

    // The rooms and groups, cached for 30 s. force: the speaker did not answer, so ask every other player
    // we know of first and finally search the network.
    function topology(force) {
        if (!force && topo && Date.now() - topo.at < TOPOLOGY_TTL_MS) return Promise.resolve(topo.data);
        var own = cfg.speaker ? cfg.speaker.address : null;
        // The player that answered last time first, then the other rooms we know of.
        var known = topo ? [topo.from].concat(topo.data.rooms.map(function (r) { return r.address; })) : [];
        var order = force ? unique(known.filter(function (a) { return a !== own; }).concat([own])) : unique([own].concat(known));
        return firstTopology(order).then(function (found) {
            if (found || !force) return found;
            return discoverAddresses().then(function (result) {
                return firstTopology(result.addresses.filter(function (a) { return order.indexOf(a) < 0; }));
            });
        }).then(function (found) {
            if (!found) throw new Error('No Sonos speaker answered');
            topo = found;
            return found.data;
        });
    }

    function findRoom(data, uuid) {
        for (var i = 0; i < data.rooms.length; i++) if (data.rooms[i].uuid === uuid) return data.rooms[i];
        return null;
    }

    // A room the topology lists at an address outside the home network (see sonos.parseTopology): the
    // error says so, instead of "not in the Sonos system" or quietly using another player.
    function refusedRoom(data, uuid, what) {
        for (var i = 0; i < data.rejected.length; i++) {
            var r = data.rejected[i];
            if (r.uuid === uuid) {
                var e = new Error(what + ' ' + r.name + ' moved to an address the Shard does not use: ' + r.error);
                e.badAddress = true;
                return e;
            }
        }
        return null;
    }

    // -> { address, mode, name }: where to send the next command.
    function resolveTarget(force) {
        if (!cfg.speaker) return Promise.reject(new Error('Choose a speaker in the Sonos tab first'));
        var speaker = cfg.speaker;
        if (!force && cfg.target === 'room') {
            return Promise.resolve({ address: sonos.parseAddress(speaker.address), mode: 'room', name: speaker.name });
        }
        if (!speaker.uuid) {
            // Typed as an address: its group is unknown, so the room itself (look it up to control its group).
            if (force) return Promise.reject(new Error('The speaker at ' + speaker.address + ' does not answer'));
            return Promise.resolve({ address: sonos.parseAddress(speaker.address), mode: 'room', name: speaker.name });
        }
        return topology(force).then(function (data) {
            var room = findRoom(data, speaker.uuid);
            if (!room) throw refusedRoom(data, speaker.uuid, 'The room') || new Error('The room ' + speaker.name + ' is not in the Sonos system any more');
            if (room.address !== speaker.address || room.name !== speaker.name) {
                note('info', room.name + ' is now at ' + room.address);
                cfg.speaker = { uuid: room.uuid, name: room.name, address: room.address };
                save();
            }
            if (cfg.target === 'group') {
                var coordinator = findRoom(data, room.coordinator);
                if (!coordinator) {
                    var refused = refusedRoom(data, room.coordinator, 'The group\u2019s main speaker');
                    if (refused) throw refused;
                    coordinator = room;
                }
                return { address: sonos.parseAddress(coordinator.address), mode: 'group', name: room.name };
            }
            return { address: sonos.parseAddress(room.address), mode: 'room', name: room.name };
        });
    }

    // Runs fn(address, mode); if the speaker cannot be reached, finds it again and retries once.
    function withSpeaker(fn) {
        return resolveTarget(false).then(function (t) {
            return fn(t.address, t.mode).then(null, function (e) {
                if (!e || !e.network) throw e;
                note('warn', e.message + '; looking for the speaker again');
                return resolveTarget(true).then(function (t2) {
                    if (t2.address.host === t.address.host && t2.address.port === t.address.port) throw e;
                    return fn(t2.address, t2.mode);
                });
            });
        });
    }

    // ---- Commands --------------------------------------------------------------------------------------

    function nextVolume(current, delta) {
        if (delta > 0) return current >= cfg.maxVolume ? current : Math.min(current + delta, cfg.maxVolume);
        return Math.max(0, current + delta);
    }

    // The chosen room and the rooms grouped with it, from the topology: [] when it plays alone.
    function groupRooms(data) {
        var room = cfg.speaker && cfg.speaker.uuid ? findRoom(data, cfg.speaker.uuid) : null;
        if (!room) return [];
        var others = data.rooms.filter(function (r) { return r.groupId === room.groupId && r.uuid !== room.uuid; });
        return others.length ? [room].concat(others) : [];
    }

    // A grouped room muted on its own stays muted when the group volume changes, and the group counts as
    // muted only when every room is. So each grouped room that is muted is unmuted by itself. -> the names.
    function unmuteGroupRooms() {
        return topology(false).then(function (data) {
            return Promise.all(groupRooms(data).map(function (r) {
                var address = sonos.parseAddress(r.address);
                return sonos.getMute(address, 'room', MEMBER_READ_MS).then(function (m) {
                    return m ? sonos.setMute(address, 'room', false).then(function () { return r.name; }) : null;
                }).then(null, function () { return null; });
            }));
        }).then(function (names) { return names.filter(Boolean); }, function () { return []; });
    }

    // delta: steps from the volume keys; to: a volume from the slider in the Sonos tab (not past the maximum).
    function changeVolume(delta, to) {
        var unmute = cfg.unmuteOnVolume;
        return withSpeaker(function (address, mode) {
            return sonos.getVolume(address, mode).then(function (current) {
                return (unmute ? sonos.getMute(address, mode) : Promise.resolve(null)).then(function (muted) {
                    var target = to == null ? nextVolume(current, delta) : Math.min(to, cfg.maxVolume);
                    var set = target !== current ? sonos.setVolume(address, mode, target) : Promise.resolve(current);
                    var rooms = unmute && mode === 'group' ? unmuteGroupRooms() : Promise.resolve([]);
                    return Promise.all([set, rooms]).then(function (done) {
                        var volume = done[0];
                        if (done[1].length) note('info', 'Unmuted ' + done[1].join(', ') + ' with the volume');
                        if (muted) return sonos.setMute(address, mode, false).then(function () { return { volume: volume, muted: false }; });
                        return { volume: volume, muted: done[1].length ? false : muted };
                    });
                });
            });
        });
    }

    function changeMute(action) {
        return withSpeaker(function (address, mode) {
            var wanted = action === 'mute' ? Promise.resolve(true)
                : action === 'unmute' ? Promise.resolve(false)
                    : sonos.getMute(address, mode).then(function (m) { return !m; });
            return wanted.then(function (m) { return sonos.setMute(address, mode, m); }).then(function (m) { return { muted: m }; });
        });
    }

    function readState() {
        return withSpeaker(function (address, mode) {
            return sonos.getVolume(address, mode).then(function (volume) {
                return sonos.getMute(address, mode).then(function (muted) { return { volume: volume, muted: muted }; });
            });
        });
    }

    // Each grouped room's own volume and mute, for the sliders in the Sonos tab. Reads the grouping from the
    // chosen speaker itself (a change in the Sonos app shows at once), else uses the last one known.
    function readGroup() {
        if (!cfg.speaker || !cfg.speaker.uuid) { group = null; return Promise.resolve(null); }
        var speaker = cfg.speaker, address;
        try { address = sonos.parseAddress(speaker.address); } catch (e) { return Promise.resolve(group); }
        return sonos.getTopology(address, LOOKUP_TIMEOUT_MS).then(function (data) {
            topo = { at: Date.now(), data: data, from: speaker.address };
            return data;
        }, function () { return topology(false); }).then(function (data) {
            return Promise.all(groupRooms(data).map(function (r) {
                var a = sonos.parseAddress(r.address);
                return Promise.all([
                    sonos.getVolume(a, 'room', MEMBER_READ_MS).then(null, function () { return null; }),
                    sonos.getMute(a, 'room', MEMBER_READ_MS).then(null, function () { return null; })
                ]).then(function (l) { return { uuid: r.uuid, name: r.name, volume: l[0], muted: l[1] }; });
            }));
        }).then(function (list) {
            if (cfg.speaker === speaker) group = list.length ? list : null;
            return group;
        }, function () { return group; });
    }

    // OK from a slider in the Sonos tab: one grouped room's own volume (not past the maximum volume).
    function setRoomVolume(body) {
        if (!cfg.speaker || !cfg.speaker.uuid) throw bad('Choose a speaker first');
        if (typeof body.uuid !== 'string' || !UUID_RE.test(body.uuid)) throw bad('Unknown room');
        if (!isInt(body.volume, 0, 100)) throw bad('Volume must be a whole number from 0 to 100');
        var volume = Math.min(body.volume, cfg.maxVolume), unmute = cfg.unmuteOnVolume;
        return topology(false).then(function (data) {
            var room = groupRooms(data).filter(function (r) { return r.uuid === body.uuid; })[0];
            if (!room) throw bad('That room is not grouped with ' + cfg.speaker.name + ' any more');
            var address = sonos.parseAddress(room.address);
            return sonos.setVolume(address, 'room', volume).then(function () {
                if (!unmute) return null;
                return sonos.getMute(address, 'room').then(function (m) { return m ? sonos.setMute(address, 'room', false) : null; });
            }).then(function () {
                note('info', room.name + ': volume ' + volume + ' (Sonos tab)');
                return readGroup();
            });
        }).then(function () { return fullState(); });
    }

    function remember(result) {
        if (result && typeof result.volume === 'number') state.volume = result.volume;
        if (result && typeof result.muted === 'boolean') state.muted = result.muted;
        state.readAt = Date.now();
        state.lastError = null;
        state.addressRefused = false;
    }

    function failed(e) {
        state.lastError = String(e && e.message || e);
        state.addressRefused = !!(e && e.badAddress);
        return state.lastError;
    }

    function snapshot(ok, error) {
        return { ok: ok, error: error || null, volume: state.volume, muted: state.muted };
    }

    // Commands run one at a time. Volume presses that arrive while one is running are added together, so a
    // burst of presses becomes one change instead of a backlog.
    // volume: for 'set-volume' (the slider in the Sonos tab), the volume to set.
    function enqueue(action, source, volume) {
        return new Promise(function (resolve) {
            if (!running) { resolve(snapshot(false, 'The Sonos controller is not running')); return; }
            if (queue.length >= MAX_QUEUE) queue.shift().resolve(snapshot(false, 'Too many commands at once'));
            queue.push({ action: action, source: source, resolve: resolve, at: Date.now(), volume: volume });
            pump();
        });
    }

    // Presses that waited too long (a slow or missing speaker) are dropped: applied late they would land
    // all at once, many seconds after the person pressed.
    function dropStale() {
        var now = Date.now(), dropped = 0;
        while (queue.length && now - queue[0].at > STALE_MS) {
            dropped++;
            queue.shift().resolve(snapshot(false, 'Dropped: waited too long for the speaker'));
        }
        if (dropped) note('warn', 'Dropped ' + dropped + ' key press' + (dropped > 1 ? 'es' : '') + ' that waited too long');
    }

    function pump() {
        if (busy || !running) return;
        dropStale();
        if (!queue.length) return;
        busy = true;
        var batch = [queue.shift()], first = batch[0].action;
        if (isVolume(first)) while (queue.length && isVolume(queue[0].action)) batch.push(queue.shift());
        // Slider moves waiting behind each other: only the last one counts.
        if (first === 'set-volume') while (queue.length && queue[0].action === 'set-volume') batch.push(queue.shift());
        var wanted = batch[batch.length - 1].volume;
        var delta = 0;
        batch.forEach(function (c) { if (c.action === 'volume-up') delta += cfg.step; if (c.action === 'volume-down') delta -= cfg.step; });
        var label = batch.length > 1 ? first + ' x' + batch.length : first, started = Date.now(), work;
        if (first === 'set-volume') label = 'volume ' + Math.min(wanted, cfg.maxVolume);
        try {
            work = isVolume(first) ? changeVolume(delta) : first === 'set-volume' ? changeVolume(0, wanted) : changeMute(first);
        } catch (e) { work = Promise.reject(e); }
        work.then(function (result) {
            remember(result);
            state.commands += batch.length;
            state.lastCommand = { action: label, source: batch[0].source, ok: true, at: Date.now(), ms: Date.now() - started };
            note('info', label + ' from ' + batch[0].source + ': volume ' + state.volume + (state.muted ? ', muted' : ''));
            // The grouped rooms' own volumes moved too: read them again for the sliders (in the background).
            if (group || cfg.target === 'group') readGroup().then(null, noop);
            return snapshot(true);
        }, function (e) {
            var message = failed(e);
            state.lastCommand = { action: label, source: batch[0].source, ok: false, at: Date.now(), error: message };
            note('error', label + ' failed: ' + message);
            return snapshot(false, message);
        }).then(function (result) {
            busy = false;
            batch.forEach(function (c) { try { c.resolve(result); } catch (e) { /* nothing to do */ } });
            pump();
        }).then(null, noop);
    }

    // ---- HTTP routes (/plugins/sonos-controller/api/<sub>) ---------------------------------------------

    function json(res, body, code) {
        res.writeHead(code || 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
    }

    function readBody(req, cb) {
        var chunks = [], size = 0, done = false;
        function finish(err, value) { if (!done) { done = true; cb(err, value); } }
        req.on('error', function (e) { finish(e); });
        req.on('data', function (c) {
            size += c.length;
            if (size > MAX_BODY) { finish(new Error('Request too large')); return; }
            chunks.push(c);
        });
        req.on('end', function () {
            var text = Buffer.concat(chunks).toString('utf8');
            if (!text) { finish(null, {}); return; }
            var value;
            try { value = JSON.parse(text); } catch (e) { finish(new Error('Invalid JSON')); return; }
            finish(null, value);
        });
    }

    // Answers a POST whose work returns a promise; errors become 400 (bad input) or 502 (speaker trouble).
    function post(req, res, work) {
        readBody(req, function (err, body) {
            if (err) { json(res, { ok: false, error: err.message }, 400); return; }
            var p;
            try { p = Promise.resolve(work(body || {})); } catch (e) { json(res, { ok: false, error: e.message }, 400); return; }
            p.then(function (out) { json(res, out); }, function (e) {
                json(res, { ok: false, error: String(e && e.message || e) }, e && e.badInput ? 400 : 502);
            }).then(null, noop);
        });
    }

    function bad(message) { var e = new Error(message); e.badInput = true; return e; }

    function fullState() {
        return {
            version: VERSION,
            running: running,
            settings: publicSettings(cfg),
            receiver: receiver ? receiver.status() : null,
            speaker: {
                volume: state.volume, muted: state.muted, readAt: state.readAt,
                lastCommand: state.lastCommand, lastError: state.lastError, addressRefused: state.addressRefused,
                commands: state.commands,
                group: group
            },
            speakerProblem: speakerProblem,
            topics: ACTIONS.map(function (a) { return { action: a, topic: cfg.topicPrefix + '/' + a }; }),
            remote: remote,
            check: lastCheck,
            checking: !!checking,
            searching: !!search,
            log: log.slice().reverse()
        };
    }

    function roomsFrom(data) {
        return data.rooms.map(function (r) {
            var group = [];
            data.rooms.forEach(function (o) { if (o.groupId === r.groupId && o.uuid !== r.uuid) group.push(o.name); });
            return { uuid: r.uuid, name: r.name, address: r.address, groupedWith: group };
        });
    }

    // Rooms left out because of their address, for the page: [{ name, address, why }].
    function skippedFrom(data) {
        return data.rejected.map(function (r) { return { name: r.name, address: r.address, why: r.why }; });
    }

    // Reads Vetro's settings (see vetro-check.js). One at a time; the result stays on the page.
    function runCheck() {
        if (checking) return checking;
        var wanted = ACTIONS.map(function (a) {
            return { action: a, topic: cfg.topicPrefix + '/' + a, key: KEY_NAMES[a], required: REQUIRED.indexOf(a) >= 0 };
        });
        var port = vetroCheck.vetroPort();
        checking = vetroCheck.read(port).then(function (data) {
            var result = vetroCheck.analyze(data, cfg, wanted);
            if (receiver && !receiver.status().listening) {
                result.items.unshift({ level: 'bad', title: 'This Shard is not listening', detail: receiver.status().error || '' });
                result.level = 'bad';
            }
            if (remote.lastIgnored) {
                result.items.push({ level: 'warn', title: 'Last ignored message: ' + remote.lastIgnored.topic, detail: remote.lastIgnored.why });
                if (result.level === 'ok') result.level = 'warn';
            }
            lastCheck = result;
            note(result.level === 'ok' ? 'info' : 'warn', 'Checked Vetro\u2019s setup: ' + (result.level === 'ok' ? 'all good' :
                result.items.filter(function (i) { return i.level !== 'ok'; }).map(function (i) { return i.title; }).join('; ')));
            return { ok: true, check: result };
        }, function (e) {
            return { ok: false, error: String(e && e.message || e) };
        });
        var mine = checking;
        mine.then(function () { if (checking === mine) checking = null; }, function () { if (checking === mine) checking = null; });
        return mine;
    }

    var page = null;
    function uiPage() {
        if (page) return page;
        var places = [path.join(__dirname, 'ui.html'), path.join(ctx.dir || '', 'ui.html')];
        for (var i = 0; i < places.length; i++) {
            try { page = fs.readFileSync(places[i], 'utf8'); return page; } catch (e) { /* next */ }
        }
        return '<!doctype html><meta charset="utf-8"><p>ui.html is missing from the Shard folder.</p>';
    }

    function applySettings(update) {
        var before = cfg, next;
        try { next = validateSettings(update, cfg); } catch (e) { throw bad(e.message); }
        cfg = next;
        if (next.speaker) speakerProblem = null;
        save();
        if (before.brokerPort !== next.brokerPort || before.username !== next.username || before.password !== next.password) {
            note('info', 'Receiver settings changed: restarting it');
            if (running) startReceiver();
        }
        var a = before.speaker, b = next.speaker;
        if (!a || !b || a.uuid !== b.uuid || a.address !== b.address || before.target !== next.target) {
            state.volume = null; state.muted = null; state.readAt = null; state.lastError = null; state.addressRefused = false;
            group = null;
            if (b && (!a || a.uuid !== b.uuid || a.address !== b.address)) note('info', 'Speaker set to ' + b.name + ' (' + b.address + ')');
        }
        return fullState();
    }

    function route(req, res, sub) {
        var method = req.method;
        if (sub === 'ui' && method === 'GET') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(uiPage());
            return true;
        }
        if (sub === 'state' && method === 'GET') { json(res, fullState()); return true; }
        if (method !== 'POST') return false;
        if (sub === 'settings') { post(req, res, applySettings); return true; }
        if (sub === 'command') {
            post(req, res, function (body) {
                if (body.action === 'set-volume') {
                    if (!isInt(body.volume, 0, 100)) throw bad('Volume must be a whole number from 0 to 100');
                    return enqueue('set-volume', 'dashboard', body.volume);
                }
                if (ACTIONS.indexOf(body.action) < 0) throw bad('Unknown action');
                return enqueue(body.action, 'dashboard');
            });
            return true;
        }
        if (sub === 'refresh') {
            post(req, res, function () {
                return readState().then(function (r) { remember(r); return snapshot(true); }, function (e) {
                    return snapshot(false, failed(e));
                }).then(function (out) { return readGroup().then(function () { out.group = group; return out; }); });
            });
            return true;
        }
        if (sub === 'lookup') {
            post(req, res, function (body) {
                var address;
                // A typed address outside the home network is refused here, before anything is sent.
                try { address = sonos.parseAddress(body.address); } catch (e) { throw bad(e.message); }
                return sonos.getTopology(address, LOOKUP_TIMEOUT_MS).then(function (data) {
                    topo = { at: Date.now(), data: data, from: sonos.formatAddress(address) };
                    return { ok: true, rooms: roomsFrom(data), skipped: skippedFrom(data) };
                });
            });
            return true;
        }
        if (sub === 'room-volume') { post(req, res, setRoomVolume); return true; }
        if (sub === 'check') {
            post(req, res, function () { return runCheck(); });
            return true;
        }
        if (sub === 'discover') {
            post(req, res, function () {
                // found: answers that were asked for their rooms; refused: answers from addresses outside
                // the home network, which were not.
                return discoverAddresses().then(function (result) {
                    var refused = result.rejected.map(function (r) { return { address: r.address, why: r.why }; });
                    return firstTopology(result.addresses).then(function (answer) {
                        if (!answer) return { ok: true, rooms: [], skipped: [], found: result.addresses.length, refused: refused };
                        topo = answer;
                        return { ok: true, rooms: roomsFrom(answer.data), skipped: skippedFrom(answer.data), found: result.addresses.length, refused: refused };
                    });
                });
            });
            return true;
        }
        return false;
    }

    // ---- Control center card ---------------------------------------------------------------------------
    //
    // One row per room: the TV speaker (the chosen room) first, then the other rooms in name order. The order
    // never depends on the grouping: after a press the launcher keeps the cursor on the same row number, so a
    // second OK must reach the same room (to undo, say). Each row reads "● 24  Kontor": filled circle when the
    // room plays the TV sound, empty when not, then its own volume (a dash when muted). OK on another room adds
    // it to the TV speaker's group or takes it out again; OK on the TV speaker changes nothing. No row is
    // ticked: Vetro ignores OK on a ticked row, and the circles say what a tick would. The card explains
    // nothing in its note: the note is only for a problem.
    var cardRows = {};                     // row id -> { uuid, name, tv, withTv } as the card showed it last
    var cardTimer = null, cardWake = null; // the wait between two readings while a change settles, and how to end it

    function rowId(prefix, uuid) {
        var id = prefix + '.' + uuid;
        return /^[A-Za-z0-9_.-]{1,40}$/.test(id) ? id : null;
    }

    // The launcher's header has room for about 33 characters: cut a longer note at a word, with an ellipsis.
    function cardNote(text) {
        text = String(text);
        if (text.length <= CARD_NOTE_MAX) return text;
        var cut = text.slice(0, CARD_NOTE_MAX - 1), space = cut.lastIndexOf(' ');
        return (space > CARD_NOTE_MAX / 2 ? cut.slice(0, space) : cut) + '…';
    }

    // "<room name><suffix>" in a note: the name is shortened so the suffix always shows.
    function nameNote(name, suffix) {
        var room = String(name), roomMax = CARD_NOTE_MAX - suffix.length;
        if (room.length > roomMax) room = room.slice(0, roomMax - 1) + '…';
        return room + suffix;
    }

    // "● 24  Kontor". volume: a number, MUTED, or null (no answer: blank, so the names still line up). wide:
    // some room on the card is at 100, so every row leaves room for three digits.
    function roomLabel(on, volume, name, wide) {
        var level = volume === null ? '' : String(volume);
        var table = wide ? cardLayout.three : cardLayout.two;
        var lead = Object.prototype.hasOwnProperty.call(table, level) ? table[level] : ' ';
        var head = (on ? DOT_ON : DOT_OFF) + lead + level + cardLayout.after;
        var room = String(name);
        if (head.length + room.length > CARD_LABEL_MAX) room = room.slice(0, CARD_LABEL_MAX - head.length - 1) + '…';
        return head + room;
    }

    // "● Salongen" in the setup rows (no volume there).
    function setupLabel(on, name) {
        var room = String(name), max = CARD_LABEL_MAX - 2;
        if (room.length > max) room = room.slice(0, max - 1) + '…';
        return (on ? DOT_ON : DOT_OFF) + ' ' + room;
    }

    function cardMessage(text, noteText) {
        cardRows = {};
        return { rows: [{ id: 'none', label: text }], note: cardNote(noteText || ''), choosable: false };
    }

    // The rooms and groups. card(): the cached ones while fresh, else one quick read of the TV speaker, else
    // the cached ones even if old (better than nothing on a card). A change (fresh: true) needs a reading made
    // now: an old one could send a room the wrong way.
    function cardTopology(maxAgeMs, timeoutMs, fresh) {
        if (!fresh && topo && Date.now() - topo.at < maxAgeMs) return Promise.resolve(topo.data);
        var address;
        try { address = sonos.parseAddress(cfg.speaker.address); } catch (e) { return Promise.reject(e); }
        return sonos.getTopology(address, timeoutMs).then(function (data) {
            topo = { at: Date.now(), data: data, from: cfg.speaker.address };
            return data;
        }, function (e) {
            if (topo && !fresh) return topo.data;
            throw e;
        });
    }

    // ---- Setup on the card: no TV speaker chosen yet --------------------------------------------------
    //
    // Row 0 is always the search; below it, the rooms of the last search or lookup in name order. OK on the
    // search looks for speakers and answers the same layout with the rooms found, so a second OK searches
    // again. OK on a room makes it the TV speaker and answers with the normal card at once. Also shown for a
    // speaker typed as an address without a lookup (no room id, so its rooms are unknown).
    function needsSetup() { return !cfg.speaker || !cfg.speaker.uuid; }

    // Reads only what is in memory: card() must answer at once even before any speaker is known.
    function setupCard(noteText) {
        var rooms = topo ? topo.data.rooms : [];
        var shown = rooms.slice(0, CARD_ROWS - 1);
        var chosen = cfg.speaker;
        var rows = [{ id: 'search', label: rooms.length ? 'Search again' : 'Search for speakers', value: '', ticked: false }];
        var ids = { search: { search: true } };
        shown.forEach(function (room) {
            var id = rowId('pick', room.uuid);
            if (!id) return;
            // A speaker typed as an address keeps an empty circle: OK on it is what gives it its room id.
            var isChosen = !!chosen && !!chosen.uuid && chosen.uuid === room.uuid;
            ids[id] = { pick: true, uuid: room.uuid, name: room.name, address: room.address };
            rows.push({ id: id, label: setupLabel(isChosen, room.name), value: '', ticked: false });
        });
        cardRows = ids;
        // No explanation on the card: the note is only for a problem.
        if (!noteText) noteText = speakerProblem && !chosen ? 'Saved speaker was not loaded' : '';
        return { rows: rows, note: cardNote(noteText), choosable: true };
    }

    function setupAnswer(ok, noteText) {
        var c = setupCard(noteText);
        return { ok: ok, rows: c.rows, note: c.note, choosable: c.choosable };
    }

    // Asks each address for its rooms in turn, each for no longer than the time left before the deadline.
    function cardFirstTopology(addresses, deadline) {
        var i = 0;
        function next() {
            var left = deadline - CARD_ANSWER_MS - Date.now();
            if (!running || i >= addresses.length || left < CARD_ANSWER_MS) return Promise.resolve(null);
            var text = addresses[i++], address;
            try { address = sonos.parseAddress(text); } catch (e) { return next(); }
            return sonos.getTopology(address, Math.min(LOOKUP_TIMEOUT_MS, left)).then(function (data) {
                return { at: Date.now(), data: data, from: text };
            }, function () { return next(); });
        }
        return next();
    }

    // OK on the search row. A speaker typed as an address is asked first; the network search only if it
    // does not answer.
    function searchFromCard() {
        var deadline = Date.now() + CARD_SELECT_MS;
        var first = cfg.speaker ? [cfg.speaker.address] : [];
        return cardFirstTopology(first, deadline).then(function (found) {
            if (found || !running) return { found: found, rejected: [] };
            return discoverAddresses().then(function (result) {
                return cardFirstTopology(result.addresses, deadline).then(function (f) { return { found: f, rejected: result.rejected }; });
            });
        }).then(function (r) {
            if (!running) return { ok: false, note: 'Sonos controller is off' };
            if (!r.found) {
                return setupAnswer(false, r.rejected.length ? 'Only non-home addresses answered' : 'No speakers found: add one by IP');
            }
            topo = r.found;
            note('info', 'Control center: found ' + r.found.data.rooms.length + ' rooms');
            if (!r.found.data.rooms.length) return setupAnswer(false, 'No usable rooms found');
            return setupAnswer(true);
        });
    }

    // OK on a room in the setup rows: it becomes the TV speaker, as choosing it in the Sonos tab does, and the
    // answer is the normal card right away (the launcher shows the rows a press answers). The cursor stays on
    // the same row number, which is now another room: a second OK there would add that room.
    function pickFromCard(listed) {
        try {
            applySettings({ speaker: { uuid: listed.uuid, name: listed.name, address: listed.address } });
        } catch (e) {
            return { ok: false, note: cardNote(e.message) };
        }
        return Promise.resolve(card()).then(function (c) { return { ok: true, rows: c.rows, note: c.note, choosable: c.choosable }; });
    }

    function card() {
        if (!running) return cardMessage('Sonos controller is off');
        if (needsSetup()) return setupCard();
        return cardTopology(CARD_TOPOLOGY_AGE_MS, CARD_READ_MS, false).then(function (data) {
            var tv = findRoom(data, cfg.speaker.uuid);
            if (!tv) {
                return cardMessage(cfg.speaker.name, refusedRoom(data, cfg.speaker.uuid, 'The room') ?
                    'TV speaker at an unusable address' : 'TV speaker not in Sonos system');
            }
            // data.rooms is in name order. Always the same rooms, whatever the grouping, so rows stay put.
            var others = data.rooms.filter(function (r) { return r.uuid !== tv.uuid; });
            var shown = [tv].concat(others).slice(0, CARD_ROWS);
            return Promise.all(shown.map(function (room) {
                var address = sonos.parseAddress(room.address);
                return Promise.all([
                    sonos.getVolume(address, 'room', CARD_READ_MS).then(null, function () { return null; }),
                    sonos.getMute(address, 'room', CARD_READ_MS).then(null, function () { return null; })
                ]);
            })).then(function (levels) {
                var rows = [], ids = {};
                var wide = levels.some(function (l) { return l[0] === 100 && !l[1]; });
                shown.forEach(function (room, i) {
                    var isTv = room.uuid === tv.uuid, withTv = !isTv && room.groupId === tv.groupId;
                    var id = rowId(isTv ? 'tv' : 'room', room.uuid);
                    if (!id) return;
                    var volume = levels[i][0], muted = levels[i][1];
                    var level = volume === null ? null : muted ? MUTED : volume;
                    ids[id] = { uuid: room.uuid, name: room.name, tv: isTv, withTv: withTv };
                    rows.push({ id: id, label: roomLabel(isTv || withTv, level, room.name, wide), value: '', ticked: false });
                });
                cardRows = ids;
                // No explanation on the card: the note is only for a problem.
                var noteText = tv.isCoordinator ? '' : 'TV speaker follows another room';
                return { rows: rows, note: cardNote(noteText), choosable: tv.isCoordinator && rows.length > 1 };
            });
        }, function () {
            return cardMessage(cfg.speaker.name, 'No answer from the speakers');
        });
    }

    // Reads the grouping again until the room's membership of the TV group is `member`, or until `until`.
    function settleGrouping(tvUuid, uuid, member, until) {
        function check() {
            if (!running || Date.now() >= until) return Promise.resolve(false);
            return cardTopology(0, CARD_READ_MS, true).then(function (data) {
                var tv = findRoom(data, tvUuid), room = findRoom(data, uuid);
                return !!(tv && room && (room.groupId === tv.groupId) === member);
            }, function () { return false; }).then(function (done) {
                if (done || !running || Date.now() >= until) return done;
                return new Promise(function (resolve) {
                    cardWake = resolve;
                    cardTimer = setTimeout(function () { cardTimer = null; cardWake = null; resolve(); }, 300);
                }).then(check);
            });
        }
        return check();
    }

    function cardSelect(id) {
        if (!running) return { ok: false, note: 'Sonos controller is off' };
        var listed = Object.prototype.hasOwnProperty.call(cardRows, id) ? cardRows[id] : null;
        if (!listed) return { ok: false, note: 'Room not on the card any more' };
        if (listed.search) return searchFromCard();
        if (listed.pick) return pickFromCard(listed);
        if (needsSetup()) return { ok: false, note: 'Choose the TV speaker first' };
        if (listed.tv) return { ok: true };            // the TV speaker itself: nothing to change
        // One limit for the whole press, under Vetro's 10 seconds (the launcher gives up after 12).
        var deadline = Date.now() + CARD_SELECT_MS;
        var tvUuid = cfg.speaker.uuid;
        // The press means what the row showed: "with TV" takes the room out, anything else adds it. Adding a
        // room that is already in, or taking out one that is already out, changes nothing.
        var leave = listed.withTv;
        return cardTopology(0, CARD_TOPOLOGY_MS, true).then(function (data) {
            var tv = findRoom(data, tvUuid), room = findRoom(data, listed.uuid);
            if (!tv) return { ok: false, note: 'TV speaker not in Sonos system' };
            if (!room) return { ok: false, note: 'Room not in Sonos system' };
            if (!tv.isCoordinator) return { ok: false, note: 'TV speaker follows another room' };
            var address = sonos.parseAddress(room.address);
            var change = leave ? sonos.leaveGroup(address, CARD_CHANGE_MS) : sonos.joinGroup(address, tv.uuid, CARD_CHANGE_MS);
            return change.then(function () {
                note('info', leave ? room.name + ' no longer plays the TV sound (Control center)' : room.name + ' now plays the TV sound (Control center)');
                // Leave enough of the limit to read the card once more; else Vetro reads it itself.
                return settleGrouping(tv.uuid, room.uuid, !leave, Math.min(Date.now() + CARD_SETTLE_MS, deadline - CARD_RESERVE_MS)).then(function () {
                    if (!running || Date.now() > deadline - CARD_RESERVE_MS) return { ok: true };
                    return Promise.resolve(card()).then(function (c) { return { ok: true, rows: c.rows, note: c.note, choosable: c.choosable }; });
                });
            }, function (e) {
                note('warn', 'Control center: ' + room.name + ': ' + (e && e.message || e));
                if (e && e.network) return { ok: false, note: nameNote(room.name, ' did not answer') };
                if (e && e.upnpCode) return { ok: false, note: 'Sonos refused it (error ' + e.upnpCode + ')' };
                return { ok: false, note: cardNote(/^Sonos refused/.test(String(e && e.message)) ? 'Sonos refused the change' : String(e && e.message || e)) };
            });
        }, function () {
            return { ok: false, note: 'No answer: nothing changed' };
        });
    }

    return {
        start: function () {
            speakerProblem = null;
            cfg = normalize(ctx.config.get(), function (key, e) {
                if (key !== 'speaker') return;
                // Most likely saved by an older version, which took any address: say so on the page.
                speakerProblem = 'The saved speaker was not loaded. ' + e.message + '. Choose the speaker again.';
                note('warn', speakerProblem);
            });
            running = true;
            busy = false;
            startReceiver();
            note('info', 'Started (version ' + VERSION + ')');
        },
        stop: function () {
            running = false;
            // A press still waiting for the speakers ends now (it sees running false) instead of hanging.
            if (cardTimer) { clearTimeout(cardTimer); cardTimer = null; }
            if (cardWake) { var wake = cardWake; cardWake = null; wake(); }
            stopReceiver();
            if (search) search.cancel();
            search = null;
            var pending = queue;
            queue = [];
            pending.forEach(function (c) { try { c.resolve(snapshot(false, 'Stopped')); } catch (e) { /* ignore */ } });
        },
        status: function () {
            var r = receiver ? receiver.status() : null;
            return {
                speaker: cfg.speaker ? cfg.speaker.name : null,
                target: cfg.target,
                receiver: r ? (r.listening ? '127.0.0.1:' + r.port : 'not listening') : 'off',
                vetroConnected: !!(r && r.clients.length),
                remotePresses: remote.presses,
                volume: state.volume,
                muted: state.muted,
                lastError: state.lastError || (r && r.error) || null
            };
        },
        route: route,
        card: card,
        cardSelect: cardSelect
    };
}

// What Vetro calls. Only home-network speaker addresses on port 1400 are used (see sonos.js).
module.exports = createShard;
module.exports.validateSettings = validateSettings;
module.exports.normalize = normalize;
module.exports.DEFAULTS = DEFAULTS;
module.exports.ACTIONS = ACTIONS;
