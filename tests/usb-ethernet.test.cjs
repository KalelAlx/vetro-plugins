'use strict';
// tv.sh of the usb-ethernet Shard, run against a fake /sys and fake `ip`, `systemctl`, `modprobe`, `insmod`, `sleep` and `dmesg`
// (VETRO_USB_ROOT and VETRO_USB_TMP point tv.sh at them). The AU7000 case is the one that was run on a real TV with 1.0.0: it must
// issue the same commands. The others (a driver that is not loaded, r8152 only, a phone, no cable, no address) have not been tried on a TV.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const cp = require('child_process');

const PLUGIN = path.join(__dirname, '..', 'plugins', 'usb-ethernet');
const TVSH = path.join(PLUGIN, 'tv.sh');

function w(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function sh(file, text) { w(file, '#!/bin/sh\n' + text); fs.chmodSync(file, 0o755); }

// A fake TV. Options: modprobe / insmod (put that command on PATH), units (default: all three).
function fakeTv(o) {
  o = o || {};
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'usb-eth-')));
  const root = path.join(dir, 'root'), tmp = path.join(dir, 'tmp'), bin = path.join(dir, 'bin'), hooks = path.join(dir, 'hooks'), stage = path.join(dir, 'stage');
  for (const d of [root, tmp, bin, hooks, stage]) fs.mkdirSync(d, { recursive: true });
  const calls = path.join(dir, 'calls');
  w(calls, '');
  w(path.join(root, 'proc/uptime'), '300.12 200.00\n');
  w(path.join(root, 'etc/tizen-release'), 'Tizen6/TV 6.0.0\n');
  w(path.join(root, 'proc/modules'), 'usbnet 20480 0 - Live 0x0\nmii 4096 1 usbnet, Live 0x0\n');
  fs.mkdirSync(path.join(root, 'sys/bus/usb/devices'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sys/class/net'), { recursive: true });
  // The built-in port: not on USB.
  fs.mkdirSync(path.join(root, 'sys/devices/platform/ethernet'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sys/class/net/eth0'), { recursive: true });
  fs.symlinkSync(path.join(root, 'sys/devices/platform/ethernet'), path.join(root, 'sys/class/net/eth0/device'));
  const tv = {
    dir, root, tmp, bin, hooks, stage, calls,
    log: () => fs.readFileSync(path.join(tmp, 'vetro-usb-ethernet.log'), 'utf8'),
    calls_: () => fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    builtin(carrier) { if (carrier !== null) w(path.join(root, 'sys/class/net/eth0/carrier'), carrier + '\n'); },
    driver(name) { fs.mkdirSync(path.join(root, 'sys/bus/usb/drivers', name), { recursive: true }); },
    module(name) { fs.mkdirSync(path.join(root, 'sys/module', name), { recursive: true }); },
    // A USB device with interfaces [[class, subclass], ...].
    usb(bus, vid, pid, interfaces, product, extra) {
      const d = path.join(root, 'sys/devices/usb1', bus);
      w(path.join(d, 'idVendor'), vid + '\n'); w(path.join(d, 'idProduct'), pid + '\n');
      w(path.join(d, 'product'), (product || 'USB 10/100/1000 LAN') + '\n'); w(path.join(d, 'speed'), '480\n');
      w(path.join(d, 'bConfigurationValue'), '2\n'); w(path.join(d, 'bNumConfigurations'), '3\n');
      if (extra) w(path.join(d, 'serial'), extra);
      interfaces.forEach((c, i) => {
        w(path.join(d, bus + ':1.' + i, 'bInterfaceClass'), c[0] + '\n'); w(path.join(d, bus + ':1.' + i, 'bInterfaceSubClass'), c[1] + '\n');
        w(path.join(d, bus + ':1.' + i, 'bInterfaceProtocol'), '00\n');
        fs.symlinkSync(path.join(d, bus + ':1.' + i), path.join(root, 'sys/bus/usb/devices', bus + ':1.' + i));
      });
      fs.symlinkSync(d, path.join(root, 'sys/bus/usb/devices', bus));
    },
    // A network interface on that USB device, bound to a driver. into: the stage (appears later, by a hook) or the real net dir.
    net(name, bus, driver, carrier, into) {
      const base = into === 'stage' ? stage : path.join(root, 'sys/class/net');
      const n = path.join(base, name);
      fs.mkdirSync(n, { recursive: true });
      fs.symlinkSync(path.join(root, 'sys/devices/usb1', bus, bus + ':1.0'), path.join(n, 'device'));
      fs.mkdirSync(path.join(root, 'sys/bus/usb/drivers', driver), { recursive: true });
      // device/driver resolves through the interface directory
      const ifd = path.join(root, 'sys/devices/usb1', bus, bus + ':1.0');
      if (!fs.existsSync(path.join(ifd, 'driver'))) fs.symlinkSync(path.join(root, 'sys/bus/usb/drivers', driver), path.join(ifd, 'driver'));
      if (carrier !== null) w(path.join(n, 'carrier'), carrier + '\n');
      w(path.join(n, 'operstate'), 'up\n');
    },
    // Runs a shell snippet when the TV does something: 'load-<module>', 'after-newid'.
    hook(name, text) { sh(path.join(hooks, name), text); },
    run(mode, env) {
      const e = Object.assign({}, process.env, {
        PATH: bin + ':/usr/bin:/bin', VETRO_USB_ROOT: root, VETRO_USB_TMP: tmp, CALLS: calls, HOOKS: hooks, FAKE_UNITS: (o.units || 'connman vd-net-config net-config'),
      }, env || {});
      return cp.spawnSync(process.env.TEST_SH || 'sh', [TVSH, mode], { env: e, encoding: 'utf8' });
    },
  };
  // ---- the fake commands ----
  sh(path.join(bin, 'sleep'), 'if [ -s "$VETRO_USB_ROOT/sys/bus/usb/drivers/cdc_ether/new_id" ] && [ -x "$HOOKS/after-newid" ]; then sh "$HOOKS/after-newid"; rm -f "$HOOKS/after-newid"; fi\nexit 0\n');
  sh(path.join(bin, 'uname'), 'case "$1" in -r) echo 5.4.77;; -m) echo armv7l;; *) echo Linux;; esac\n');
  sh(path.join(bin, 'ip'), `
N="$VETRO_USB_ROOT/sys/class/net"
case "$*" in
  "link set "*" name "*) echo "ip $*" >> "$CALLS"; mv "$N/$3" "$N/$5" ;;
  "link set "*) echo "ip $*" >> "$CALLS" ;;
  "-4 -o addr show dev "*) [ -e "$N/$6/.ip" ] && echo "2: $6 inet 10.0.0.5/24 scope global $6"; exit 0 ;;
  route) [ -e "$N/eth0/.ip" ] && echo "default via 10.0.0.1 dev eth0"; exit 0 ;;
esac
exit 0
`);
  sh(path.join(bin, 'systemctl'), `
case "$1" in
  restart) echo "systemctl $*" >> "$CALLS"
    if [ -n "$FAKE_DHCP" ] && [ "$(cat "$VETRO_USB_ROOT/sys/class/net/eth0/carrier" 2>/dev/null)" = 1 ]; then : > "$VETRO_USB_ROOT/sys/class/net/eth0/.ip"; fi ;;
  cat) case " $FAKE_UNITS " in *" \${2%.service} "*) exit 0;; esac; exit 1 ;;
esac
exit 0
`);
  sh(path.join(bin, 'dmesg'), 'echo "usb 1-1: new high-speed USB device number 3"; echo "eth1: v1.10 HWaddr 00:11:22:AA:BB:CC lease 192.168.1.77"; echo "unrelated line"\n');
  const loader = (name) => `echo "${name} $*" >> "$CALLS"; m=$(basename "$1" .ko); mkdir -p "$VETRO_USB_ROOT/sys/module/$m"; [ -x "$HOOKS/load-$m" ] && sh "$HOOKS/load-$m"; exit 0\n`;
  if (o.modprobe) sh(path.join(bin, 'modprobe'), loader('modprobe'));
  if (o.insmod) sh(path.join(bin, 'insmod'), loader('insmod'));
  // the module files that tv.sh looks for when there is no modprobe
  for (const m of o.ko || []) w(path.join(root, 'usr/lib/modules/5.4.77/kernel/drivers/net/usb', m + '.ko'), '');
  return tv;
}

// The AU7000 as it was probed: RTL8153 in its CDC configuration, cdc_ether loaded, no r8152.ko.
function au7000(extra) {
  extra = extra || {};
  const tv = fakeTv(Object.assign({ modprobe: false }, extra));
  tv.usb('1-1', '0bda', '8153', [['02', '06'], ['0a', '00']]);
  tv.module('cdc_ether'); tv.module('usbnet'); tv.driver('cdc_ether');
  w(path.join(tv.root, 'sys/bus/usb/drivers/cdc_ether/new_id'), '');
  // bound: the adapter already has its interface; else it appears when the id is written
  tv.net('eth1', '1-1', 'cdc_ether', 1, extra.bound ? undefined : 'stage');
  if (!extra.bound) tv.hook('after-newid', `cp -R "${tv.stage}/eth1" "$VETRO_USB_ROOT/sys/class/net/eth1"`);
  tv.builtin(0);
  return tv;
}
function result(tv) { const l = tv.log().trim().split('\n'); return l[l.length - 1]; }

test('AU7000: the commands are those that worked on the TV with 1.0.0', () => {
  const tv = au7000();
  assert.match(tv.run('check').stdout, /^state=bind iface=- carrier=- ip=- adapter=0bda:8153 /);
  const r = tv.run('apply', { FAKE_DHCP: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(tv.root, 'sys/bus/usb/drivers/cdc_ether/new_id'), 'utf8').trim(), '0bda 8153 02 0000 0000');
  assert.deepEqual(tv.calls_(), [
    'ip link set eth1 up',   // new in 1.1.0: to read its cable. Everything after it is what 1.0.0 did.
    'ip link set eth0 down', 'ip link set eth0 name ethb', 'ip link set eth1 down', 'ip link set eth1 name eth0',
    'systemctl restart connman.service', 'systemctl restart vd-net-config.service', 'systemctl restart net-config.service',
  ]);
  assert.equal(result(tv), 'result=done');
  assert.match(tv.run('check').stdout, /^state=in-place iface=eth0 carrier=1 ip=yes adapter=0bda:8153 driver=cdc_ether /);
  assert.ok(!fs.existsSync(path.join(tv.tmp, 'vetro-usb-ethernet.lock')), 'the lock is gone');
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(tv.log()), 'no address in the log');
});

test('a TV that has not loaded cdc_ether: it is loaded first, then given the id', () => {
  const tv = fakeTv({ modprobe: true });
  tv.usb('1-1', '0bda', '8153', [['02', '06'], ['0a', '00']]);
  tv.builtin(0);
  tv.net('eth1', '1-1', 'cdc_ether', 1, 'stage');
  tv.hook('load-cdc_ether', 'mkdir -p "$VETRO_USB_ROOT/sys/bus/usb/drivers/cdc_ether"; : > "$VETRO_USB_ROOT/sys/bus/usb/drivers/cdc_ether/new_id"');
  tv.hook('after-newid', `cp -R "${tv.stage}/eth1" "$VETRO_USB_ROOT/sys/class/net/eth1"`);
  tv.driver('cdc_ether'); fs.rmSync(path.join(tv.root, 'sys/bus/usb/drivers/cdc_ether'), { recursive: true }); // the net() helper made it: not loaded yet
  tv.run('apply', { FAKE_DHCP: '1' });
  const calls = tv.calls_();
  assert.equal(calls[0], 'modprobe cdc_ether');
  assert.equal(fs.readFileSync(path.join(tv.root, 'sys/bus/usb/drivers/cdc_ether/new_id'), 'utf8').trim(), '0bda 8153 02 0000 0000');
  assert.ok(calls.includes('ip link set eth1 name eth0'));
  assert.equal(result(tv), 'result=done');
});

test('firmware with r8152 only: no CDC interface, so r8152 is loaded (with insmod, there being no modprobe)', () => {
  const tv = fakeTv({ insmod: true, ko: ['r8152'] });
  tv.usb('1-1', '0bda', '8153', [['ff', '00']]);
  tv.builtin(0);
  tv.net('eth1', '1-1', 'r8152', 1, 'stage');
  tv.hook('load-r8152', `cp -R "${tv.stage}/eth1" "$VETRO_USB_ROOT/sys/class/net/eth1"`);
  tv.run('apply', { FAKE_DHCP: '1' });
  const calls = tv.calls_();
  assert.ok(calls[0].startsWith('insmod ') && calls[0].endsWith('r8152.ko'), calls[0]);
  assert.ok(!fs.existsSync(path.join(tv.root, 'sys/bus/usb/drivers/cdc_ether/new_id')), 'cdc_ether was not touched');
  assert.ok(calls.includes('ip link set eth1 name eth0'));
  assert.equal(result(tv), 'result=done');
});

test('r8152 after cdc_ether gave nothing; no driver at all gives result=no-driver and renames nothing', () => {
  const tv = fakeTv({ modprobe: true });
  tv.usb('1-1', '0bda', '8153', [['02', '06']]);
  tv.builtin(0);
  tv.hook('load-cdc_ether', 'mkdir -p "$VETRO_USB_ROOT/sys/bus/usb/drivers/cdc_ether"; : > "$VETRO_USB_ROOT/sys/bus/usb/drivers/cdc_ether/new_id"');
  tv.run('apply');
  assert.deepEqual(tv.calls_(), ['modprobe cdc_ether', 'modprobe r8152']);
  assert.equal(result(tv), 'result=no-driver');
});

test('a phone tethering over USB is never taken for the adapter', () => {
  const tv = fakeTv({ modprobe: true });
  tv.usb('1-2', '18d1', '4eeb', [['02', '06'], ['0a', '00']], 'Pixel');
  tv.net('usb0', '1-2', 'cdc_ether', 1);
  tv.builtin(0);
  assert.match(tv.run('check').stdout, /^state=none /);
  tv.run('apply');
  assert.deepEqual(tv.calls_(), []);
  assert.equal(result(tv), 'result=none');
  // but a branded Realtek adapter that cdc_ether took by itself is one
  const tv2 = fakeTv();
  tv2.usb('1-1', '17ef', '3069', [['02', '06']]);
  tv2.net('eth1', '1-1', 'cdc_ether', 1);
  tv2.builtin(0);
  assert.match(tv2.run('check').stdout, /^state=swap iface=eth1 .* adapter=17ef:3069 driver=cdc_ether /);
});

test('a built-in port that is itself a USB chip (asix) is not taken for the adapter', () => {
  const tv = fakeTv({ modprobe: false });
  fs.rmSync(path.join(tv.root, 'sys/class/net/eth0'), { recursive: true });
  tv.usb('1-9', '0b95', '1790', [['ff', '00']], 'Built-in');
  tv.net('eth0', '1-9', 'asix', 0);
  tv.usb('1-1', '0bda', '8153', [['02', '06'], ['0a', '00']]);
  tv.module('cdc_ether'); tv.module('usbnet'); tv.driver('cdc_ether');
  w(path.join(tv.root, 'sys/bus/usb/drivers/cdc_ether/new_id'), '');
  tv.net('eth1', '1-1', 'cdc_ether', 1, 'stage');
  tv.hook('after-newid', `cp -R "${tv.stage}/eth1" "$VETRO_USB_ROOT/sys/class/net/eth1"`);
  assert.match(tv.run('check').stdout, /^state=bind iface=- .* adapter=0bda:8153 /);
  tv.run('apply', { FAKE_DHCP: '1' });
  const calls = tv.calls_();
  assert.ok(calls.includes('ip link set eth0 name ethb') && calls.includes('ip link set eth1 name eth0'), calls.join('; '));
  assert.equal(result(tv), 'result=done');
  assert.match(tv.run('check').stdout, /^state=in-place iface=eth0 .* adapter=0bda:8153 driver=cdc_ether /);
});

test('an adapter without a cable changes nothing: Wi-Fi stays', () => {
  const tv = au7000({ bound: true });
  w(path.join(tv.root, 'sys/class/net/eth1/carrier'), '0\n');
  tv.run('apply', { FAKE_DHCP: '1' });
  assert.deepEqual(tv.calls_().filter((c) => /name|restart/.test(c)), []);
  assert.equal(result(tv), 'result=no-cable');
  assert.match(tv.run('check').stdout, /^state=no-cable iface=eth1 /);
});

test('the built-in port with a cable, or unreadable, keeps it as it is', () => {
  const tv = au7000({ bound: true }); tv.builtin(1);
  assert.match(tv.run('check').stdout, /^state=builtin-cable /);
  tv.run('apply');
  assert.equal(result(tv), 'result=builtin-cable');
  assert.deepEqual(tv.calls_().filter((c) => /name|restart/.test(c)), []);
  const tv2 = au7000({ bound: true }); fs.rmSync(path.join(tv2.root, 'sys/class/net/eth0/carrier'), { force: true });
  assert.match(tv2.run('check').stdout, /^state=builtin-unknown /);
  tv2.run('apply', { FAKE_DHCP: '1' });
  assert.ok(tv2.calls_().includes('ip link set eth0 up'), 'brought up to read it');
});

test('no address with a cable: the names go back, the services restart, nothing is tried again this boot', () => {
  const tv = au7000();
  tv.run('apply');   // no FAKE_DHCP: the TV never gives an address
  assert.equal(result(tv), 'result=reverted');
  assert.ok(fs.existsSync(path.join(tv.tmp, 'vetro-usb-ethernet.reverted')));
  assert.deepEqual(fs.readdirSync(path.join(tv.root, 'sys/class/net')).sort(), ['eth0', 'eth1']);
  assert.ok(fs.existsSync(path.join(tv.root, 'sys/class/net/eth1/device')), 'eth1 is the adapter again');
  assert.equal(tv.calls_().filter((c) => c === 'systemctl restart connman.service').length, 2, 'restarted for the swap and for the way back');
  assert.match(tv.run('check').stdout, /^state=reverted /);
  const before = tv.calls_().length;
  tv.run('apply');
  assert.equal(tv.calls_().length, before, 'a second run does nothing');
});

test('units that do not exist are not restarted', () => {
  const tv = au7000({ units: 'connman' });
  tv.run('apply', { FAKE_DHCP: '1' });
  assert.deepEqual(tv.calls_().filter((c) => c.startsWith('systemctl')), ['systemctl restart connman.service']);
  assert.match(tv.log(), /vd-net-config: no unit/);
});

test('one setup at a time: a live lock gives result=busy, a stale one is taken over', () => {
  const tv = au7000();
  fs.mkdirSync(path.join(tv.tmp, 'vetro-usb-ethernet.lock'));
  w(path.join(tv.tmp, 'vetro-usb-ethernet.lock', 'pid'), process.pid + '\n');
  assert.match(tv.run('check').stdout, /^state=applying /);
  assert.match(tv.run('apply').stdout, /result=busy/);
  assert.deepEqual(tv.calls_(), []);
  w(path.join(tv.tmp, 'vetro-usb-ethernet.lock', 'pid'), '999999\n');
  tv.run('apply', { FAKE_DHCP: '1' });
  assert.equal(result(tv), 'result=done');
});

test('the report names the devices and drivers and leaves out serials, MACs and addresses', () => {
  const tv = au7000();
  tv.usb('1-3', '1234', '5678', [['08', '06']], 'Some stick', 'SECRET-SERIAL-123');
  const r = tv.run('report');
  assert.equal(r.status, 0, r.stderr);
  const t = r.stdout;
  assert.match(t, /1-1 id=0bda:8153 product="USB 10\/100\/1000 LAN"/);
  assert.match(t, /1-3 id=1234:5678/);
  assert.match(t, /modprobe: no/);
  assert.match(t, /connman\.service: yes/);
  assert.match(t, /state=bind adapter=0bda:8153/);
  assert.match(t, /usb 1-1: new high-speed USB device/);
  assert.ok(!t.includes('SECRET-SERIAL-123'), 'no serial number');
  assert.ok(!t.includes('00:11:22:AA:BB:CC'), 'no MAC address');
  assert.ok(!t.includes('192.168.1.77'), 'no IP address');
  assert.ok(t.includes('xx:xx:xx:xx:xx:xx') && t.includes('x.x.x.x'));
  assert.ok(!/unrelated line/.test(t), 'only USB and network lines of the kernel log');
});

test('the Shard: report and state routes, run through the real tv.sh', async () => {
  const tv = au7000();
  const shard = require(PLUGIN)({
    dir: PLUGIN,
    execute: (cmd) => new Promise((resolve) => {
      cp.exec(cmd, { env: Object.assign({}, process.env, { PATH: tv.bin + ':/usr/bin:/bin', VETRO_USB_ROOT: tv.root, VETRO_USB_TMP: tv.tmp, CALLS: tv.calls, HOOKS: tv.hooks, FAKE_UNITS: 'connman' }) },
        (err, stdout) => resolve({ stdout: stdout || '', exit_code: err ? 1 : 0 }));
    }),
    config: { get: () => ({}), set: () => {} },
  });
  const reply = (sub) => new Promise((resolve) => {
    const res = { writeHead(c) { this.code = c; }, end(b) { resolve({ code: this.code, body: b }); } };
    assert.equal(shard.route({ method: 'GET' }, res, sub), true);
  });
  const rep = await reply('report');
  assert.equal(rep.code, 200);
  const text = JSON.parse(rep.body).text;
  assert.match(text, /^USB Ethernet report\nShard version: 1\.1\.0\n/);
  assert.match(text, /Shard state: \{"state":"starting"/);
  assert.match(text, /1-1 id=0bda:8153/);
  assert.equal((await reply('state')).code, 200);
  assert.match((await reply('ui')).body, /Make the report/);
  assert.equal(shard.route({ method: 'GET' }, {}, 'nothing'), false);
});
