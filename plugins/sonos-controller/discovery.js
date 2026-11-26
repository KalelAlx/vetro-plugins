'use strict';
// Finds Sonos players on the LAN with an SSDP search (UDP multicast to 239.255.255.250:1900).
// Only a convenience: typing a speaker's IP address works without it, and some networks or
// TVs drop multicast. Plain ES5.
//
// Anyone on the network can answer a search, with any LOCATION. Only answers whose LOCATION is a
// home-network address are used (sonos.parseAddress decides); the others are kept apart as rejected,
// so the page can say a speaker answered from an address the Shard will not use.

var dgram = require('dgram');
var compat = require('./compat.js');
var sonos = require('./sonos.js');

var SEARCH = [
    'M-SEARCH * HTTP/1.1',
    'HOST: 239.255.255.250:1900',
    'MAN: "ssdp:discover"',
    'MX: 1',
    'ST: urn:schemas-upnp-org:device:ZonePlayer:1',
    '', ''
].join('\r\n');

var LOCATION_RE = /^LOCATION:\s*https?:\/\/([^\/:\s]+)(?::(\d+))?/im;
var SONOS_RE = /sonos|ZonePlayer/i;

// One answer to the search -> null (not a Sonos player, or no LOCATION), { address: { host, port } } or,
// when LOCATION is not a home-network address, { rejected: { address, why, error } }.
function parseResponse(text) {
    if (!SONOS_RE.test(text)) return null;
    var m = LOCATION_RE.exec(text);
    if (!m) return null;
    var shown = m[1] + (m[2] ? ':' + m[2] : '');
    try {
        return { address: sonos.parseAddress(shown) };
    } catch (e) {
        return { rejected: { address: shown, why: e.why || 'is not a speaker address', error: e.message } };
    }
}

// Returns { promise, cancel }. The promise resolves to { found: [{ host, port }], rejected: [{ address,
// why, error }] } (either possibly empty) after windowMs, or earlier with what was found if cancel() is
// called. It never rejects.
function search(windowMs) {
    var found = [], rejected = [], seen = {}, socket = null, timer = null, resent = null, done = false, finish;
    var promise = new Promise(function (resolve) {
        finish = function () {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            if (resent) clearTimeout(resent);
            timer = resent = null;
            if (socket) { try { socket.close(); } catch (e) { /* already closed */ } }
            socket = null;
            resolve({ found: found, rejected: rejected });
        };
    });
    try {
        socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (e) {
        finish();
        return { promise: promise, cancel: finish };
    }
    var message = compat.fromString(SEARCH);
    function send() {
        if (done || !socket) return;
        try { socket.send(message, 0, message.length, 1900, '239.255.255.250'); } catch (e) { /* network down */ }
    }
    socket.on('error', function () { finish(); });
    socket.on('message', function (msg) {
        var answer = parseResponse(msg.toString('utf8'));
        if (!answer) return;
        var key = answer.address ? sonos.formatAddress(answer.address) : answer.rejected.address;
        if (seen[key]) return;
        seen[key] = true;
        if (answer.address) found.push(answer.address); else rejected.push(answer.rejected);
    });
    try {
        socket.bind(function () {
            send();
            resent = setTimeout(function () { resent = null; send(); }, 400);   // UDP may drop the first one
        });
    } catch (e) {
        finish();
    }
    timer = setTimeout(finish, windowMs || 2500);
    return { promise: promise, cancel: finish };
}

module.exports = { search: search, parseResponse: parseResponse };
