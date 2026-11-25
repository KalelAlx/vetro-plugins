'use strict';
// Local control of Sonos speakers over the LAN: the UPnP/SOAP services every player serves on port 1400.
// No cloud, no account. Action and argument names are taken from the player's own service descriptions
// (/xml/RenderingControl1.xml and /xml/GroupRenderingControl1.xml):
//
//   RenderingControl       GetVolume / SetVolume (DesiredVolume) / GetMute / SetMute (DesiredMute)
//                          InstanceID 0, Channel Master. Sent to a room's main player, this is the room's
//                          volume: a home theatre (Playbar + surrounds + Sub) follows it as one.
//   GroupRenderingControl  GetGroupVolume / SetGroupVolume / GetGroupMute / SetGroupMute / SnapshotGroupVolume
//                          InstanceID 0, sent to the group's coordinator. Changes every room in the group,
//                          keeping their relative levels.
//   ZoneGroupTopology      GetZoneGroupState: rooms, their players' addresses and how they are grouped.
//
// Only speakers on the home network: every address, however it arrives (typed in the page, found by the
// network search, listed by a speaker's topology or read from an older config.json), goes through
// parseAddress below, which accepts a private IPv4 address and nothing else. See "Which addresses".
//
// Plain ES5: the TV may run Node 4.4.

var http = require('http');

var DEFAULT_PORT = 1400;
var TIMEOUT_MS = 4000;
var MAX_RESPONSE = 1048576;
var MAX_NAME = 64;            // longest room name the Shard keeps (index.js checks saved names against it)

var SERVICES = {
    rendering: { path: '/MediaRenderer/RenderingControl/Control', urn: 'urn:schemas-upnp-org:service:RenderingControl:1' },
    group: { path: '/MediaRenderer/GroupRenderingControl/Control', urn: 'urn:schemas-upnp-org:service:GroupRenderingControl:1' },
    topology: { path: '/ZoneGroupTopology/Control', urn: 'urn:schemas-upnp-org:service:ZoneGroupTopology:1' },
    transport: { path: '/MediaRenderer/AVTransport/Control', urn: 'urn:schemas-upnp-org:service:AVTransport:1' }
};
var PLAYER_ID_RE = /^RINCON_[A-Za-z0-9]{1,40}$/;   // a Sonos player's id, as the topology lists it

var ADDRESS_RE = /^([^:\s]+)(?::(\d{1,5}))?$/;
var IPV4_RE = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;
var NAME_RE = /^[A-Za-z0-9.-]{1,253}$/;
var LOCATION_RE = /^https?:\/\/([^\/:]+)(?::(\d+))?/;

// ---- Which addresses ------------------------------------------------------------------------------
//
// The Shard runs inside Vetro on the TV and sends HTTP requests to the speaker address it is given. So
// that it cannot be pointed at anything but a speaker on the home network, an address must be:
//
//   - four decimal numbers 0-255, without leading zeros. No host names: "localhost" or a name that
//     resolves to another machine would get around the check below. No leading zeros either: some
//     systems read "010.0.0.1" as octal, and "0177.0.0.1" is 127.0.0.1;
//   - in a private IPv4 range (RFC 1918): 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16, which is where a
//     home router gives out addresses;
//   - on port 1400, the only port a Sonos player answers on (fixed in its firmware). A bare address means
//     port 1400; any other port is refused, so neither a speaker's topology nor a network-search answer
//     can point the Shard at another service on a home-network machine.
//
// Everything else is refused, with a message for the settings page. In particular:
//
//   - 127.0.0.0/8 (loopback) is the TV itself. Vetro's own service listens there (port 8099) and runs
//     commands as root for local callers without a key: a speaker address must never lead to it;
//   - 0.0.0.0/8 means "this device", and a connection to 0.0.0.0 also reaches the TV itself;
//   - 169.254.0.0/16 (link-local) is refused too. A speaker only has such an address when it did not get
//     one from the router, and then it is not reliably reachable from the TV anyway; the range also holds
//     169.254.169.254, the classic target of this kind of request forgery. The message says what to do;
//   - public addresses, 100.64.0.0/10 (carrier-grade NAT), multicast and broadcast.
//
// The port is not limited: Sonos uses 1400, and the requests are fixed SOAP calls to fixed paths.

var LOCAL_HINT = 'Speakers must have a local address: 192.168.x.x, 10.x.x.x or 172.16.x.x to 172.31.x.x';

function refuse(text, why, advice) {
    var e = new Error(text + ' ' + why + '. ' + (advice || LOCAL_HINT));
    e.badAddress = true;
    e.why = why;               // the short reason, for lists of left-out rooms
    return e;
}

// [a, b, c, d] -> null when the address is a private (home network) address, else the reason it is not.
function rangeProblem(o) {
    if (o[0] === 10) return null;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return null;
    if (o[0] === 192 && o[1] === 168) return null;
    if (o[0] === 127) return 'loopback';
    if (o[0] === 0) return 'this-device';
    if (o[0] === 169 && o[1] === 254) return 'link-local';
    return 'not-local';
}

// Throws when host may not be used as a speaker.
function checkHost(host, text) {
    var m = IPV4_RE.exec(host);
    if (!m) {
        if (host.toLowerCase() === 'localhost') throw refuse(text, 'is the TV itself, not a speaker');
        if (NAME_RE.test(host) && /[A-Za-z]/.test(host)) {
            throw refuse(text, 'is a name, not an IP address', 'Type the speaker\u2019s IP address, like 192.168.1.20');
        }
        throw new Error('Not a speaker address: ' + text + '. Type the IP address of a Sonos speaker, like 192.168.1.20');
    }
    var octets = [];
    for (var i = 1; i <= 4; i++) {
        if (m[i].length > 1 && m[i].charAt(0) === '0') {
            throw refuse(text, 'has a number with a leading zero', 'Type it without leading zeros, like 192.168.1.20');
        }
        var n = Number(m[i]);
        if (n > 255) throw new Error('Not a speaker address: ' + text + '. Each number must be 0 to 255');
        octets.push(n);
    }
    switch (rangeProblem(octets)) {
        case null: return;
        case 'loopback': throw refuse(text, 'is the TV itself, not a speaker');
        case 'this-device': throw refuse(text, 'means this device, not a speaker');
        case 'link-local':
            throw refuse(text, 'is a self-assigned link-local address',
                'The speaker did not get an address from your router: restart it, check that it is on the same network as the TV, then search again');
        default: throw refuse(text, 'is not on your home network');
    }
}

// "192.168.1.3" or "192.168.1.3:1400" -> { host, port: 1400 }. Throws on anything else, including another
// port and addresses outside the home network (see above); the error's message is meant for the settings page.
function parseAddress(text) {
    var shown = String(text == null ? '' : text).trim();
    var m = ADDRESS_RE.exec(shown);
    if (!m) throw new Error('Not a speaker address: ' + (shown || '(empty)') + '. Type the IP address of a Sonos speaker, like 192.168.1.20');
    checkHost(m[1], shown);
    if (m[2] && Number(m[2]) !== DEFAULT_PORT) {
        throw refuse(shown, 'uses port ' + Number(m[2]) + ', not 1400',
            'Sonos speakers always answer on port 1400: type the address without a port, like 192.168.1.20');
    }
    return { host: m[1], port: DEFAULT_PORT };
}

function formatAddress(a) {
    return a.port === DEFAULT_PORT ? a.host : a.host + ':' + a.port;
}

// A room name cut to MAX_NAME characters. Sonos allows longer names. If the cut falls inside an emoji
// (two UTF-16 units), its first half is dropped too, so the name stays valid text when saved.
function shortName(text) {
    var s = String(text);
    if (s.length <= MAX_NAME) return s;
    s = s.slice(0, MAX_NAME);
    var last = s.charCodeAt(s.length - 1);
    return last >= 0xD800 && last <= 0xDBFF ? s.slice(0, -1) : s;
}

function unescapeXml(s) {
    return String(s)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(Number(n)); })
        .replace(/&amp;/g, '&');
}

function escapeXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function tagValue(xml, name) {
    var m = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(xml);
    return m ? m[1] : null;
}

function soapError(action, status, text) {
    var code = tagValue(text, 'errorCode');
    var e = new Error('Sonos refused ' + action + ' (HTTP ' + status + (code ? ', UPnP error ' + code : '') + ')');
    e.upnpCode = code ? Number(code) : null;
    return e;
}

// One SOAP call. args: [[name, value], ...] in the order the service lists them. Resolves to the raw
// response body (XML); network failures reject with e.network = true so callers can look the speaker up again.
function call(address, serviceKey, action, args, timeoutMs) {
    var service = SERVICES[serviceKey];
    var inner = (args || []).map(function (a) { return '<' + a[0] + '>' + escapeXml(a[1]) + '</' + a[0] + '>'; }).join('');
    var body = '<?xml version="1.0" encoding="utf-8"?>' +
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
        '<s:Body><u:' + action + ' xmlns:u="' + service.urn + '">' + inner + '</u:' + action + '></s:Body></s:Envelope>';
    return new Promise(function (resolve, reject) {
        var settled = false, timer = null, req;
        function fail(e, network) {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (network) e.network = true;
            reject(e);
        }
        try {
            req = http.request({
                host: address.host,
                port: address.port || DEFAULT_PORT,
                method: 'POST',
                path: service.path,
                agent: false,
                headers: {
                    'Content-Type': 'text/xml; charset="utf-8"',
                    'SOAPACTION': '"' + service.urn + '#' + action + '"',
                    'Content-Length': Buffer.byteLength(body),
                    'Connection': 'close'
                }
            }, function (res) {
                var chunks = [], size = 0;
                res.on('error', function (e) { fail(e, true); });
                res.on('data', function (c) {
                    size += c.length;
                    if (size > MAX_RESPONSE) { fail(new Error('Sonos answer too large')); res.destroy(); return; }
                    chunks.push(c);
                });
                res.on('end', function () {
                    if (settled) return;
                    var text = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode !== 200) { fail(soapError(action, res.statusCode, text)); return; }
                    settled = true;
                    if (timer) clearTimeout(timer);
                    resolve(text);
                });
            });
        } catch (e) {
            fail(e, true);
            return;
        }
        req.on('error', function (e) {
            fail(new Error('Cannot reach the speaker at ' + formatAddress(address) + ' (' + (e.code || e.message) + ')'), true);
        });
        // One timer for the whole request, connecting included: req.setTimeout() only starts once the socket
        // is connected on Node 12 (the TV), so a speaker that never answers the connection would hold the
        // queue until the system gives up on it, about two minutes later. Cleared as soon as the call settles.
        timer = setTimeout(function () {
            timer = null;
            fail(new Error('The speaker at ' + formatAddress(address) + ' did not answer in time'), true);
            if (typeof req.destroy === 'function') req.destroy(); else req.abort();
        }, timeoutMs || TIMEOUT_MS);
        req.end(body);
    });
}

function readInt(text, name, action) {
    var v = tagValue(text, name);
    if (v === null || !/^\d+$/.test(v.trim())) throw new Error('Unexpected answer to ' + action);
    return Number(v.trim());
}

var MASTER = [['InstanceID', '0'], ['Channel', 'Master']];
var INSTANCE = [['InstanceID', '0']];

// mode 'room': RenderingControl on the room's player. mode 'group': GroupRenderingControl on the coordinator.
// timeoutMs (optional): a shorter limit than TIMEOUT_MS, for the Control center card.
function getVolume(address, mode, timeoutMs) {
    if (mode === 'group') {
        return call(address, 'group', 'GetGroupVolume', INSTANCE, timeoutMs).then(function (t) { return readInt(t, 'CurrentVolume', 'GetGroupVolume'); });
    }
    return call(address, 'rendering', 'GetVolume', MASTER, timeoutMs).then(function (t) { return readInt(t, 'CurrentVolume', 'GetVolume'); });
}

function setVolume(address, mode, volume) {
    var v = String(Math.max(0, Math.min(100, Math.round(volume))));
    if (mode === 'group') {
        // Sonos keeps the rooms' relative levels from the last snapshot; take one first.
        return call(address, 'group', 'SnapshotGroupVolume', INSTANCE).then(function () {
            return call(address, 'group', 'SetGroupVolume', INSTANCE.concat([['DesiredVolume', v]]));
        }).then(function () { return Number(v); });
    }
    return call(address, 'rendering', 'SetVolume', MASTER.concat([['DesiredVolume', v]])).then(function () { return Number(v); });
}

function getMute(address, mode, timeoutMs) {
    if (mode === 'group') {
        return call(address, 'group', 'GetGroupMute', INSTANCE, timeoutMs).then(function (t) { return readInt(t, 'CurrentMute', 'GetGroupMute') === 1; });
    }
    return call(address, 'rendering', 'GetMute', MASTER, timeoutMs).then(function (t) { return readInt(t, 'CurrentMute', 'GetMute') === 1; });
}

function setMute(address, mode, muted) {
    var v = muted ? '1' : '0';
    if (mode === 'group') return call(address, 'group', 'SetGroupMute', INSTANCE.concat([['DesiredMute', v]])).then(function () { return !!muted; });
    return call(address, 'rendering', 'SetMute', MASTER.concat([['DesiredMute', v]])).then(function () { return !!muted; });
}

// ---- Grouping (AVTransport on the room's own player) ---------------------------------------------------
//
// The rooms of a Sonos group all play what the group's coordinator plays. The Control center card uses this
// to let more rooms play the TV sound: the TV speaker (a Playbar, say) is the coordinator of its group, and a
// room joins that group or leaves it.

// The room at address joins the group led by the player coordinatorId (it then plays what that group
// plays, and stops what it played before). The URI "x-rincon:<id>" is how Sonos names "follow this player".
function joinGroup(address, coordinatorId, timeoutMs) {
    if (typeof coordinatorId !== 'string' || !PLAYER_ID_RE.test(coordinatorId)) {
        return Promise.reject(new Error('Not a Sonos player id: ' + coordinatorId));
    }
    return call(address, 'transport', 'SetAVTransportURI',
        INSTANCE.concat([['CurrentURI', 'x-rincon:' + coordinatorId], ['CurrentURIMetaData', '']]), timeoutMs).then(function () { return true; });
}

// The room at address leaves its group and plays on its own (silent until something is played there).
function leaveGroup(address, timeoutMs) {
    return call(address, 'transport', 'BecomeCoordinatorOfStandaloneGroup', INSTANCE, timeoutMs).then(function () { return true; });
}

function attributes(text) {
    var out = {}, re = /([A-Za-z_][\w.-]*)="([^"]*)"/g, m;
    while ((m = re.exec(text))) out[m[1]] = unescapeXml(m[2]);
    return out;
}

// The answer of GetZoneGroupState -> { groups: [{ id, coordinator, members: [room] }], rooms: [room], rejected }.
// room: { uuid, name, host, port, address, groupId, coordinator (uuid), isCoordinator }; name is at most
// MAX_NAME characters.
// Hidden members (the second half of a stereo pair and the like) are left out; satellites
// (surrounds, Sub) are separate <Satellite> elements and never listed as rooms.
// A room whose Location is not a home-network address (see parseAddress) is not used: it goes to
// rejected as { uuid, name, address, why, error } so the page can say why it is missing.
function parseTopology(responseXml) {
    var state = tagValue(responseXml, 'ZoneGroupState');
    if (state === null) throw new Error('Unexpected answer to GetZoneGroupState');
    var xml = unescapeXml(state);
    var groups = [], rooms = [], rejected = [];
    var groupRe = /<ZoneGroup\b([^>]*)>([\s\S]*?)<\/ZoneGroup>/g, g;
    while ((g = groupRe.exec(xml))) {
        var ga = attributes(g[1]);
        var group = { id: ga.ID || '', coordinator: ga.Coordinator || '', members: [] };
        var memberRe = /<ZoneGroupMember\b([^>]*?)\/?>/g, m;
        while ((m = memberRe.exec(g[2]))) {
            var a = attributes(m[1]);
            if (!a.UUID || a.Invisible === '1') continue;
            var name = shortName(a.ZoneName || a.UUID);
            var loc = LOCATION_RE.exec(a.Location || '');
            if (!loc) continue;
            var text = loc[1] + (loc[2] ? ':' + loc[2] : ''), address;
            try {
                address = parseAddress(text);
            } catch (e) {
                rejected.push({ uuid: a.UUID, name: name, address: text, why: e.why || 'is not a speaker address', error: e.message });
                continue;
            }
            var room = {
                uuid: a.UUID,
                name: name,
                host: address.host,
                port: address.port,
                groupId: group.id,
                coordinator: group.coordinator,
                isCoordinator: a.UUID === group.coordinator
            };
            room.address = formatAddress(room);
            group.members.push(room);
            rooms.push(room);
        }
        if (group.members.length) groups.push(group);
    }
    rooms.sort(function (x, y) { return x.name < y.name ? -1 : x.name > y.name ? 1 : 0; });
    return { groups: groups, rooms: rooms, rejected: rejected };
}

function getTopology(address, timeoutMs) {
    return call(address, 'topology', 'GetZoneGroupState', [], timeoutMs).then(function (xml) {
        return parseTopology(xml);
    });
}

module.exports = {
    DEFAULT_PORT: DEFAULT_PORT,
    MAX_NAME: MAX_NAME,
    shortName: shortName,
    parseAddress: parseAddress,
    formatAddress: formatAddress,
    parseTopology: parseTopology,
    getTopology: getTopology,
    getVolume: getVolume,
    setVolume: setVolume,
    getMute: getMute,
    setMute: setMute,
    joinGroup: joinGroup,
    leaveGroup: leaveGroup,
    call: call
};
