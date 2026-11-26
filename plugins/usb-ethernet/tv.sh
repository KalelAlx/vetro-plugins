# Runs on the TV as root. $1: check (reads only), report (reads only, for people) or apply (loads a driver, renames, restarts
# the network services). VETRO_USB_ROOT and VETRO_USB_TMP are for the Shard's tests only: unset, everything is the real TV.
mode=$1
R=${VETRO_USB_ROOT:-}
T=${VETRO_USB_TMP:-/tmp}
USB=$R/sys/bus/usb/devices
NET=$R/sys/class/net
LOG=$T/vetro-usb-ethernet.log
LOCK=$T/vetro-usb-ethernet.lock
MARK=$T/vetro-usb-ethernet.reverted
# USB ids that the Linux r8152 driver lists for Realtek RTL8152/8153/8156 adapters and their branded versions.
IDS=" 0bda:8050 0bda:8152 0bda:8153 0bda:8155 0bda:8156 045e:07ab 045e:07c6 04e8:a101 0955:09ff 13b1:0041 17ef:304f 17ef:3052 17ef:3054 17ef:3057 17ef:3062 17ef:3069 17ef:3082 17ef:3098 17ef:7205 17ef:720a 17ef:720b 17ef:720c 17ef:7214 17ef:721e 17ef:8153 17ef:a359 17ef:a387 2357:0601 "
# Network drivers that are always an Ethernet adapter. cdc_ether, rndis_host, cdc_ncm and ipheth are also phones and tethering.
DRIVERS=" r8152 asix ax88179_178a "

adapter=; vid=; pid=; iface=; drv=; st=none; ecm=no

rd() { cat "$1" 2>/dev/null; }
has_ip() { ip -4 -o addr show dev "$1" 2>/dev/null | grep -q inet; }
unit_exists() { [ -e "$R/usr/lib/systemd/system/$1.service" ] || [ -e "$R/lib/systemd/system/$1.service" ] || systemctl cat "$1.service" >/dev/null 2>&1; }
in_ids() { case "$IDS" in *" $1 "*) return 0;; esac; return 1; }
logline() { echo "$(date '+%H:%M:%S') $*"; }

# Finds the adapter: first by its network interface (driver one of DRIVERS, or cdc_ether with an id from IDS), then by the
# USB id alone (an adapter without a driver yet). Sets adapter vid pid iface drv.
scan() {
  adapter=; vid=; pid=; iface=; drv=
  for nd in "$NET"/*; do
    [ -e "$nd/device" ] || continue
    dev=$(readlink -f "$nd/device" 2>/dev/null)
    case "$dev" in */usb*|*/[0-9]*-[0-9]*:*) ;; *) continue;; esac
    base=${dev##*/}; bus=${base%%:*}
    [ -f "$USB/$bus/idVendor" ] || continue
    d=$(basename "$(readlink -f "$nd/device/driver" 2>/dev/null)" 2>/dev/null)
    v=$(rd "$USB/$bus/idVendor"); p=$(rd "$USB/$bus/idProduct")
    ok=no
    case "$DRIVERS" in *" $d "*) ok=yes;; esac
    [ "$d" = cdc_ether ] && in_ids "$v:$p" && ok=yes
    # The TV's own port may itself be a USB chip (asix): an eth0 that is not on a known Realtek id is the adapter only after the swap.
    [ "${nd##*/}" = eth0 ] && [ ! -e "$NET/ethb" ] && ! in_ids "$v:$p" && ok=no
    if [ $ok = yes ]; then adapter=$bus; vid=$v; pid=$p; iface=${nd##*/}; drv=$d; return; fi
  done
  for d in "$USB"/*; do
    case "${d##*/}" in *:*) continue;; esac
    [ -f "$d/idVendor" ] || continue
    v=$(rd "$d/idVendor"); p=$(rd "$d/idProduct")
    if in_ids "$v:$p"; then adapter=${d##*/}; vid=$v; pid=$p; return; fi
  done
}

# Sets st (and ecm) from what scan found.
decide() {
  st=none; ecm=no
  [ -n "$adapter" ] || return
  for i in "$USB/$adapter":*; do
    [ "$(rd "$i/bInterfaceClass")$(rd "$i/bInterfaceSubClass")" = 0206 ] && ecm=yes
  done
  if [ -z "$iface" ]; then st=bind; return; fi
  if [ "$iface" = eth0 ]; then st=in-place; return; fi
  c=$(rd "$NET/$iface/carrier")
  if [ ! -e "$NET/eth0" ]; then
    case "$c" in 0) st=no-cable;; *) st=swap;; esac
    return
  fi
  # The built-in port must read "no cable" (0). A cable (1) or an unreadable value keeps it as it is.
  b=$(rd "$NET/eth0/carrier")
  case "$b" in
    0) case "$c" in 0) st=no-cable;; *) st=swap;; esac;;
    1) st=builtin-cable;;
    *) st=builtin-unknown;;
  esac
}

lock_alive() { [ -d "$LOCK" ] && kill -0 "$(rd "$LOCK/pid")" 2>/dev/null; }

if [ "$mode" = check ]; then
  scan; decide
  [ -e "$MARK" ] && st=reverted
  lock_alive && st=applying
  c=-; a=-
  if [ -n "$iface" ]; then
    c=$(rd "$NET/$iface/carrier"); c=${c:-0}
    if has_ip "$iface"; then a=yes; else a=no; fi
  fi
  echo "state=$st iface=${iface:--} carrier=$c ip=$a adapter=${vid:+$vid:$pid} driver=${drv:--} up=$(cut -d. -f1 "$R/proc/uptime")"
  exit 0
fi

if [ "$mode" = report ]; then
  # Everything below is read-only. No serial number, no MAC address, no IP address, no host name: addresses that slip in
  # through the kernel log are replaced at the end.
  {
    echo "== TV"
    echo "kernel: $(uname -r) $(uname -m)"
    head -n 6 "$R/etc/tizen-release" 2>/dev/null
    echo "uptime_s: $(cut -d. -f1 "$R/proc/uptime")"
    echo "== USB devices"
    for d in "$USB"/*; do
      case "${d##*/}" in *:*) continue;; esac
      [ -f "$d/idVendor" ] || continue
      echo "- ${d##*/} id=$(rd "$d/idVendor"):$(rd "$d/idProduct") product=\"$(rd "$d/product")\" speed=$(rd "$d/speed") config=$(rd "$d/bConfigurationValue")/$(rd "$d/bNumConfigurations")"
      for i in "$USB/${d##*/}":*; do
        [ -e "$i" ] || continue
        dr=$(basename "$(readlink -f "$i/driver" 2>/dev/null)" 2>/dev/null); [ -e "$i/driver" ] || dr=-
        echo "    ${i##*/} class=$(rd "$i/bInterfaceClass")/$(rd "$i/bInterfaceSubClass")/$(rd "$i/bInterfaceProtocol") driver=$dr"
      done
    done
    echo "== network interfaces (no addresses)"
    for n in "$NET"/*; do
      [ -e "$n" ] || continue
      dr=-; [ -e "$n/device/driver" ] && dr=$(basename "$(readlink -f "$n/device/driver" 2>/dev/null)" 2>/dev/null)
      bus=no; case "$(readlink -f "$n/device" 2>/dev/null)" in */usb*|*/[0-9]*-[0-9]*:*) bus=usb;; esac
      ip4=no; has_ip "${n##*/}" && ip4=yes
      echo "- ${n##*/} driver=$dr bus=$bus state=$(rd "$n/operstate") carrier=$(rd "$n/carrier") speed=$(rd "$n/speed") ipv4=$ip4"
    done
    echo "default route via: $(ip route 2>/dev/null | awk '/^default/ { for (i = 1; i < NF; i++) if ($i == "dev") print $(i + 1) }' | sort -u | tr '\n' ' ')"
    echo "== USB network modules"
    echo "loaded: $(awk '{print $1}' "$R/proc/modules" 2>/dev/null | grep -E '^(usbnet|cdc_|asix|ax88|r815|rndis|ipheth|mii)' | tr '\n' ' ')"
    echo "available: $(ls "$R/usr/lib/modules/$(uname -r)/kernel/drivers/net/usb" 2>/dev/null | tr '\n' ' ')"
    echo "== tools and units"
    for c in modprobe insmod kmod setsid systemctl ip dmesg; do
      if command -v "$c" >/dev/null 2>&1; then echo "$c: yes"; else echo "$c: no"; fi
    done
    for u in connman vd-net-config net-config; do
      if unit_exists "$u"; then echo "$u.service: yes"; else echo "$u.service: no"; fi
    done
    echo "== connman main.conf"
    grep -E '^(NetworkInterfaceBlacklist|NetworkCellularInterfaceList|SingleConnectedTechnology)' "$R/etc/connman/main.conf" 2>/dev/null
    echo "== what the Shard sees"
    scan; decide
    [ -e "$MARK" ] && st=reverted
    lock_alive && st=applying
    echo "state=$st adapter=${vid:+$vid:$pid} iface=${iface:--} driver=${drv:--} ecm_interface=$ecm"
    echo "== last setup log"
    tail -n 40 "$LOG" 2>/dev/null
    echo "== kernel log (usb and network lines)"
    dmesg 2>/dev/null | grep -i -E 'usb|cdc|r8152|asix|ax88|rtl81|eth[0-9b]|link (is|becomes)' | tail -n 60
  } 2>&1 | sed -e 's/[0-9]\{1,3\}\(\.[0-9]\{1,3\}\)\{3\}/x.x.x.x/g' \
               -e 's/\([0-9A-Fa-f]\{2\}:\)\{5\}[0-9A-Fa-f]\{2\}/xx:xx:xx:xx:xx:xx/g'
  exit 0
fi

[ "$mode" = apply ] || exit 2

# ---- apply ---------------------------------------------------------------------------------------------------------

# Only one setup at a time: a run takes up to two minutes and the Shard looks again every minute.
if ! mkdir "$LOCK" 2>/dev/null; then
  if lock_alive; then echo "result=busy"; exit 0; fi
  rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || { echo "result=busy"; exit 0; }
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT
# After a rollback nothing is tried again until the TV restarts; the log of the rollback stays as it is.
if [ -e "$MARK" ]; then echo "result=reverted"; exit 0; fi
exec > "$LOG" 2>&1
date

# Loads a kernel module (and usbnet, which cdc_ether needs). modprobe, else insmod, else kmod under the name insmod.
load_mod() {
  [ -d "$R/sys/module/$1" ] && return 0
  if command -v modprobe >/dev/null 2>&1 && modprobe "$1" 2>/dev/null; then echo "loaded $1 with modprobe"; return 0; fi
  ko=$(find "$R/usr/lib/modules/$(uname -r)" -name "$1.ko" 2>/dev/null | head -n 1)
  [ -n "$ko" ] || { echo "no $1.ko on this TV"; return 1; }
  [ "$1" = cdc_ether ] && [ ! -d "$R/sys/module/usbnet" ] && load_mod usbnet
  if command -v insmod >/dev/null 2>&1; then ins=insmod
  elif command -v kmod >/dev/null 2>&1; then
    mkdir -p "$T/vetro-usb-ethernet.bin" && ln -sf "$(command -v kmod)" "$T/vetro-usb-ethernet.bin/insmod" && ins=$T/vetro-usb-ethernet.bin/insmod
  else echo "no modprobe, insmod or kmod"; return 1; fi
  if $ins "$ko"; then echo "loaded $1 with ${ins##*/}"; return 0; fi
  echo "could not load $1"; return 1
}

# Waits for the adapter to get a network interface ($1 seconds at most).
wait_iface() {
  n=0
  while [ "$n" -lt "$1" ]; do
    scan; [ -n "$iface" ] && return 0
    sleep 1; n=$((n + 1))
  done
  scan; [ -n "$iface" ]
}

restart_units() {
  if unit_exists connman; then systemctl restart connman.service; echo "connman rc=$?"; else echo "connman: no unit"; fi
  sleep 8
  for u in vd-net-config net-config; do
    if unit_exists "$u"; then systemctl restart "$u.service"; echo "$u rc=$?"; else echo "$u: no unit"; fi
  done
}

scan; decide
echo "start: state=$st adapter=${vid:+$vid:$pid} iface=${iface:--} driver=${drv:--} ecm=$ecm"

# 1. A driver for the adapter. The generic cdc_ether driver first (the way that is known to work), then Realtek's r8152.
if [ $st = bind ]; then
  if [ $ecm = yes ]; then
    if load_mod cdc_ether && [ -d "$R/sys/bus/usb/drivers/cdc_ether" ]; then
      echo "$vid $pid 02 0000 0000" > "$R/sys/bus/usb/drivers/cdc_ether/new_id"
      echo "new_id rc=$?"
      wait_iface 10 && echo "cdc_ether took it as $iface"
    fi
  fi
  if [ -z "$iface" ]; then
    if load_mod r8152; then wait_iface 15 && echo "r8152 took it as $iface"; fi
  fi
  if [ -z "$iface" ]; then echo "result=no-driver"; exit 0; fi
  decide
  echo "after the driver: state=$st iface=${iface:--} driver=${drv:--}"
fi

# 2. A built-in port that is down cannot say whether it has a cable: bring it up and read again.
if [ $st = builtin-unknown ]; then
  ip link set eth0 up; sleep 3; scan; decide
  echo "built-in port up: state=$st"
fi

# 3. The adapter needs a cable before anything is renamed: without one the TV keeps the connection it has.
if [ $st = swap ] || [ $st = no-cable ]; then
  ip link set "$iface" up
  n=0
  while [ "$(rd "$NET/$iface/carrier")" != 1 ] && [ $n -lt 8 ]; do sleep 1; n=$((n + 1)); done
  if [ "$(rd "$NET/$iface/carrier")" = 1 ]; then st=swap; else st=no-cable; fi
fi
if [ $st = no-cable ]; then echo "result=no-cable"; exit 0; fi
if [ $st != swap ] && [ $st != in-place ]; then echo "result=$st"; exit 0; fi

# 4. The built-in port gives its name to the adapter (Samsung's network services only treat eth0 as the wired one).
orig=$iface; hadb=no
if [ $st = swap ]; then
  if [ -e "$NET/eth0" ]; then
    ip link set eth0 down
    ip link set eth0 name ethb || { ip link set eth0 up; echo "result=rename-failed"; exit 1; }
    hadb=yes
  fi
  ip link set "$iface" down
  if ! ip link set "$iface" name eth0; then
    ip link set "$iface" up
    [ $hadb = yes ] && ip link set ethb name eth0 && ip link set eth0 up
    echo "result=rename-failed"; exit 1
  fi
  echo "renamed: $(ls "$NET" | tr '\n' ' ')"
elif has_ip eth0 || [ "$(rd "$NET/eth0/carrier")" != 1 ]; then
  # In place already (an adapter plugged in again gets eth0 by itself): restart only if it has a cable and no address.
  echo "result=nothing-to-do"; exit 0
fi

restart_units

# 5. An address within a minute, or everything goes back (the TV must not be left without a network).
n=0
while [ $n -lt 30 ]; do
  has_ip eth0 && break
  sleep 2; n=$((n + 1))
done
echo "carrier=$(rd "$NET/eth0/carrier")"
if has_ip eth0; then echo "route via: $(ip route 2>/dev/null | awk '/^default/ { for (i = 1; i < NF; i++) if ($i == "dev") print $(i + 1) }' | sort -u | tr '\n' ' ')"; echo "result=done"; exit 0; fi
if [ "$(rd "$NET/eth0/carrier")" = 1 ] && [ $st = swap ]; then
  echo "no address after a minute with a cable: putting the names back"
  ip link set eth0 down
  ip link set eth0 name "$orig"
  if [ $hadb = yes ]; then ip link set ethb name eth0; ip link set eth0 up; fi
  : > "$MARK"
  restart_units
  echo "result=reverted"; exit 0
fi
echo "result=no-address"
