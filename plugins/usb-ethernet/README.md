# USB Ethernet

Makes the TV use a **USB-to-Ethernet adapter** as its wired connection, and does it again after every TV restart. It is meant
for TVs where the adapter's light comes on but the TV never shows a wired connection, because the firmware has no driver
loaded for it. The TV's USB ports are USB 2.0, so expect about 70 Mbit/s at most: more than many built-in ports and most
Wi-Fi links manage.

It works with Realtek **RTL8152 / RTL8153 / RTL8156** adapters and their branded versions (the USB ids that the Linux `r8152`
driver lists: Realtek, Microsoft, Samsung, Lenovo, TP-Link, Linksys, NVIDIA). An adapter that the TV already drives with
its own `asix`, `ax88179_178a` or `r8152` driver is also used as the wired connection. A phone sharing its connection over
USB is never touched.

**If your adapter does not work, open the Shard's page and make a report** (see *The report*): it shows what your TV
offers, and is how support for other TVs and adapters grows.

## Before you switch it on

- **Leave the TV's own Ethernet port empty.** With a cable there, the Shard does nothing.
- **Plug the network cable into the adapter.** Without a cable on the adapter nothing is changed and the TV stays on Wi-Fi.
- **The TV's address changes** when it moves from Wi-Fi to the cable. After the first run, open the dashboard at the new
  address (Settings → General → Network → Network Status on the TV, or your router's list of devices).
- **The network drops for a few seconds** about a minute after each TV start, while the TV's network services restart.
- **If the TV gets no address from the adapter within a minute**, the Shard puts the names back, restarts the network
  services so that the TV returns to Wi-Fi, and stops until the next TV restart. The page says so.
- **Wi-Fi is dropped** once the cable is up: the TV keeps one connection at a time.
- **Switching the Shard off changes nothing until the next TV restart.** To get the built-in port back, switch it off and
  restart the TV.

## How it works

On the firmwares this was written for, the generic USB network driver (`cdc_ether`) refuses Realtek adapters by their USB
id, and leaves them to Realtek's own driver, which is not loaded. For an adapter that has no network interface yet, the
Shard tries, in this order:

1. **`cdc_ether`**, when the adapter offers the standard CDC Ethernet mode: the driver is loaded if it is not (`modprobe`,
   else `insmod`), then told the adapter's id (`new_id`). This is the way that was tried on a real TV.
2. **`r8152`**, when there is no CDC Ethernet mode or step 1 gave no interface: the module is loaded the same way.
3. If neither gives an interface, it says so (*no driver on this TV can drive this adapter*) and the report shows why.

Samsung's network services only treat an interface called `eth0` as the wired one, so once the adapter has an interface
and a cable, the built-in port is renamed `ethb`, the adapter becomes `eth0`, and the network services are restarted. A TV
restart undoes all of it, which is why the Shard checks one minute after the TV starts and then once a minute (an adapter
plugged in later is picked up too). It runs a setup at most three times per start of Vetro, and never two at once.

## The report

The page has a **Make the report** button. The report is a text file with:

- the kernel and Tizen version, and how long the TV has been up;
- each USB device: its id (like `0bda:8153`), product name, speed, configuration, and for each interface its class and the
  driver that has it;
- each network interface: driver, whether it is on USB, state, cable, speed and whether it has an IPv4 address (yes or no);
- which USB network drivers are loaded and which are on the TV, which of `modprobe`, `insmod` and `kmod` exist, and which of
  the three network services exist;
- the lines of Connman's settings that name interfaces;
- the last setup's log, and the USB and network lines of the kernel log;
- what the Shard decided (its state, the adapter it found, the driver it saw).

**It leaves out** serial numbers, MAC addresses, IP addresses and the host name: any that appear in the kernel log are
replaced by `xx:xx:xx:xx:xx:xx` and `x.x.x.x`. Nothing is sent anywhere. You read it on the page, then **save it as a
file** or **copy** it, and post it where you ask for help (if the dashboard blocks downloads, copying always works). You can
type the TV's model into the page first (it is printed on the back); it is added at the top of the report.

## Permissions

`exec`: loading a driver, binding a USB device, renaming network interfaces and restarting the TV's network services need root.

## Commands it runs

All of them are in [`tv.sh`](tv.sh), sent to the TV's root agent as one script.

| Command | Why |
| --- | --- |
| `tv.sh check`: reads `/sys/bus/usb/devices/*` (`idVendor`, `idProduct`, interface classes), `/sys/class/net/*` (`device`, `driver`, `carrier`), `ip -4 -o addr show`, `/proc/uptime`, a lock file in `/tmp` | to find the adapter, its interface and whether it has a cable and an address. Reads only. Every minute, 8 s timeout |
| `tv.sh report`: the same, plus `/proc/modules`, `/usr/lib/modules/<kernel>/kernel/drivers/net/usb`, `/etc/tizen-release`, `/etc/connman/main.conf`, `ip route`, `command -v`, `systemctl cat`, `dmesg` | the text of the report. Reads only, only when you press the button |
| `tv.sh apply`, run in the background (`setsid`), output in `/tmp/vetro-usb-ethernet.log`, a lock directory in `/tmp` | only when the check finds an adapter that is not set up yet and the built-in port has no cable: |
| `modprobe cdc_ether` (or `insmod` of its `.ko`, and of `usbnet.ko` if that is not loaded) | the generic driver, when it is not loaded. When the TV has no `modprobe` or `insmod`, a symbolic link called `insmod` to `kmod` is made in `/tmp/vetro-usb-ethernet.bin` |
| `echo "<vendor> <product> 02 0000 0000" > /sys/bus/usb/drivers/cdc_ether/new_id` | lets the generic driver take the adapter |
| `modprobe r8152` (or `insmod` of its `.ko`) | Realtek's driver, when the generic one gave no interface |
| `ip link set <port> up`, only for the adapter, or for the built-in port when it is down | a port that is down cannot say whether it has a cable; without a clear "no cable" nothing is renamed |
| `ip link set eth0 name ethb`, `ip link set <adapter> name eth0` (each after `ip link set … down`) | the built-in port gives its name to the adapter |
| `systemctl restart connman.service`, then `systemctl restart vd-net-config.service net-config.service` (each only if it exists) | Samsung's network services pick up the new `eth0` |
| the same renames the other way, and the same restarts, once, if there is no address after a minute with a cable | putting the TV back on its own connection |
| `tail -n 1` / `cat /tmp/vetro-usb-ethernet.log` | the result of the last run, on this Shard's page |

## Network

None. It sends nothing anywhere.

## Data it keeps

None. It does not use `ctx.config`. The log of the last run, the lock, the marker of a rollback and, when the TV has no `insmod`,
the `insmod` link to `kmod` (`/tmp/vetro-usb-ethernet.bin`) are in `/tmp` on the TV and go away at the next restart.

## Tested

**Tried on a real TV:** an AU7000 (2021, Tizen 6.0) with an RTL8153 adapter, with version 1.0.0, which did this: `new_id`
for the generic driver, the renames and the restarts. After a TV restart the Shard set it up on its own, the adapter became
the TV's wired connection with an address and the default route, and Network Status showed Ethernet. The steps above are the
same, and the automated test replays that case and checks that the commands are the same, plus bringing the adapter up to read
its cable.

**Not tried on a real TV yet:** 1.1.0 itself; loading `cdc_ether` or `r8152` when the TV has not loaded them; the `r8152`
route; adapters other than that RTL8153; other TVs, other Tizen versions; the rollback. They are tested only against a
simulated TV (`tests/usb-ethernet.test.cjs`: a fake `/sys` and fake `ip`, `systemctl` and `modprobe`). If you try it, the
report is the most useful thing you can send, whether it worked or not.
