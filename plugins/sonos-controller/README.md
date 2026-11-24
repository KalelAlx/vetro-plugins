# Sonos controller

Your TV remote's volume and mute keys control a Sonos room instead of the TV. Vetro catches the keys and
publishes an MQTT message for each press; this Shard receives those messages itself (no separate broker,
no Home Assistant) and sends the change straight to the Sonos speaker on your network. A **Sonos** tab
shows the volume, lets you pick the room, the step per press and a maximum volume, and lists the exact
values to enter in Vetro.

## How it works

```
remote key ─▶ Vetro: Remote interception + rule "Publish MQTT message"
          ─▶ this Shard: MQTT receiver on 127.0.0.1:1883
          ─▶ Sonos speaker: HTTP on port 1400 (the local UPnP interface the Sonos app also uses)
```

| Topic (default prefix `vetro/sonos`) | What it does |
| --- | --- |
| `vetro/sonos/volume-up` | volume up by the step (default 2), not past the maximum; unmutes |
| `vetro/sonos/volume-down` | volume down by the step; unmutes |
| `vetro/sonos/mute-toggle` | mute, or unmute if muted |
| `vetro/sonos/mute`, `vetro/sonos/unmute` | explicit mute and unmute |

The payload does not matter. Quick presses that arrive while a change is still being sent are added
together into one change. "This room only" changes the chosen room (a home theatre with surrounds and Sub
counts as one room); "the whole group" changes every room grouped with it, keeping their balance.

## Setup

1. Install and switch on this Shard, open its **Sonos** tab and choose the room: **Search the network**,
   or type the IP address of any Sonos speaker and **Look up** (the Sonos app shows it under Settings ›
   System › About my system). The speakers must be on the same home network as the TV, with a local
   address such as `192.168.1.20`; see [Network](#network) for what happens otherwise.
2. In Vetro's **MQTT** page, set broker `127.0.0.1`, port `1883`, no user name, TLS off, keep the topic
   prefix `vetro`, enable and save. The tab shows **Vetro connected** within half a minute.
3. In Vetro's **Remote** page, choose the remote, **Start listening**, and press Volume up, Volume down
   and Mute to see their key codes, then **Stop listening**. (On a 2022 The Frame with the infrared remote,
   device "wt61p807 rc device": 68, 67 and 66.)
4. Add three rules in the MQTT page. For each, change **Trigger type** from the default "MQTT message" to
   **Physical key**, enter the code, leave the payload blank, and choose **Publish MQTT message** to
   `vetro/sonos/volume-up`, `vetro/sonos/volume-down` and `vetro/sonos/mute-toggle`.
5. In the Remote page, choose your remote in the device menu (not "Detect automatically": that one only
   listens, and Vetro refuses to intercept with it). Then turn on **Remote interception** and press
   **Check Vetro setup** in the Sonos tab. Vetro intercepts one remote device at a time (0.5.0 and 0.7.0);
   keys from another remote (for example a Bluetooth one) still go to the TV.
6. On Vetro 0.7.0 or later, keep Vetro UI's **Volume bar** switched off (Vetro UI → On-screen displays). It
   claims Vol +, Vol − and Mute (68, 67 and 66) for Vetro's own on-screen bar, and the rules for them then
   never run. It is off unless you turn it on; **Check Vetro setup** says when it holds one of the keys.

### When the keys do nothing

Vetro runs a rule for a remote key only while **Remote interception** is running, and only for keys it
intercepts. While **Start listening** is active, no rule runs: listening pauses interception until it is
stopped, or until Vetro stops it by itself (Vetro 0.5.0: after five minutes without the Remote page open;
0.7.0: after two minutes). A rule whose trigger type was left on "MQTT message" waits for a message instead of
a key, and never fires. On Vetro 0.7.0, a key that Vetro UI's Volume bar holds goes to that bar, not to the
rules (step 6).

**Check Vetro setup** finds these: it reads Vetro's MQTT settings, rules and interception state and lists
what is wrong, with the last keys Vetro saw and whether they were intercepted. The Volume card shows how
many key presses arrived from Vetro, and the activity log names any message on a topic that is not a
command (a mistyped rule topic).

Vetro's MQTT link now points at this Shard, so it cannot also talk to another broker. If a key press
reaches Vetro while this Shard is off, Vetro gives the keys back to the TV for a minute and then tries again.

## Permissions

None. It runs no commands.

## Network

- **Listens** on `127.0.0.1` (TCP, port 1883 by default) for Vetro's MQTT connection. Only programs on
  the TV can reach it. An optional user name and password can be required.
- **Connects** to the Sonos speakers on your local network, HTTP port 1400: reads and sets volume and
  mute, and reads which rooms exist and how they are grouped. Nothing else is sent to them.
- **Speakers on the home network only.** The Shard sends requests only to a private IPv4 address:
  `10.x.x.x`, `172.16.x.x` to `172.31.x.x` or `192.168.x.x`, written as four plain numbers (an optional
  `:port` is allowed). This applies to every address, however it arrives: typed in the Sonos tab, found by
  the network search, listed by a speaker for the other rooms, or saved in `config.json` by an older
  version. Everything else is refused before anything is sent to it, and the Sonos tab says why:
  - the TV itself: `127.x.x.x` and `localhost` (Vetro's own service listens there), and `0.0.0.0`;
  - host names such as `sonos.local`, and numbers written with leading zeros;
  - public addresses and other ranges, such as `100.64.x.x`;
  - self-assigned `169.254.x.x` addresses. A speaker only has one when it got no address from the router,
    and it is then not reliably reachable from the TV anyway; the range also holds `169.254.169.254`, a
    well-known target for misused requests. Restart the speaker or fix its network connection so it gets
    an address from the router, then search again.

  Typing such an address gives a message under **Look up**. Rooms a speaker lists at such an address, and
  search answers from one, are left out of the room list, and the tab names them. A speaker saved by an
  older version at such an address is not loaded: the Sonos tab says so until you choose the speaker again.
  If a chosen room moves to such an address, the keys stop working and the tab shows the reason.
- **Search the network** sends an SSDP search (UDP multicast to `239.255.255.250:1900`); only when you
  press the button, or when the chosen speaker stops answering and no other speaker knows where it went.
- **Check Vetro setup** reads Vetro's own settings from Vetro's service on the TV (`127.0.0.1`, port 8099
  or the port Vetro was built with): `GET /mqtt` (without the password), `GET /remap` and `GET /input`.
  Read-only, and only when you press the button. See below: this is not part of the Shard API.
- No internet, no Sonos account, no cloud. Nothing is sent anywhere else.

## Goes around the Shard API (Check Vetro setup only)

The Shard API gives a Shard no access to Vetro's MQTT settings, rules or remote interception, so **Check
Vetro setup** goes around it:

- it calls Vetro's own HTTP routes `GET /mqtt`, `GET /remap` and `GET /input` from the TV itself, which
  Vetro answers without pairing;
- to find Vetro's port it reads `build-info.js` next to Vetro's main script (else `VETRO_PORT`, else 8099).

This is **not supported** by Vetro and **can break with any Vetro update**. It only reads, never changes a
setting, and runs only when you press the button. Opening `/input` also counts as "the Remote page is
open" for Vetro, which is why it never runs on a timer. If a Vetro update breaks it, the Check reports that
it could not read Vetro's settings; the volume keys themselves do not depend on it.

## Data it keeps

Its own `config.json`: the chosen room (name, Sonos id, address), room or group, step, maximum volume,
whether volume keys unmute, the receiver's port and topic prefix, and the optional user name and password
(stored in plain text on the TV; the page never shows the password again).

## Tested

On a computer, with Vetro's own MQTT client and bridge (from Vetro 0.5.0) connected to the receiver and a
simulated Sonos player that checks each request against the action and argument names in a real player's
service descriptions. The Sonos commands were also sent to a real Playbar (grouped with another room) and
read back: room and group volume, mute and unmute all worked, and room mode left the other room untouched.

On a 2022 The Frame (Vetro 0.5.0, Node 12.16) with Remote interception on the infrared remote ("wt61p807 rc
device", codes 68, 67 and 66), reported by the owner: volume up, volume down and mute from the remote
control a Sonos Playbar. Not tested: network search (SSDP) on the TV, and remotes other than the infrared one.
