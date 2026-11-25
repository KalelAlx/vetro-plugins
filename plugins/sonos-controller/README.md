# Sonos controller

Your TV remote's volume and mute keys control a Sonos room instead of the TV. Vetro catches the keys and
publishes an MQTT message for each press; this Shard receives those messages itself (no separate broker,
no Home Assistant) and sends the change straight to the Sonos speaker on your network. A **Sonos** tab
shows the volume, lets you pick the room, the step per press and a maximum volume, and lists the exact
values to enter in Vetro. The volume bar can be dragged (or moved with the arrow keys), and while the room
is grouped the tab also has a volume slider for each room in the group.

## How it works

```
remote key ─▶ Vetro: Remote interception + rule "Publish MQTT message"
          ─▶ this Shard: MQTT receiver on 127.0.0.1:1883
          ─▶ Sonos speaker: HTTP on port 1400 (the local UPnP interface the Sonos app also uses)
```

| Topic (default prefix `vetro/sonos`) | What it does |
| --- | --- |
| `vetro/sonos/volume-up` | volume up by the step (default 3), not past the maximum; unmutes |
| `vetro/sonos/volume-down` | volume down by the step; unmutes |
| `vetro/sonos/mute-toggle` | mute, or unmute if muted |
| `vetro/sonos/mute`, `vetro/sonos/unmute` | explicit mute and unmute |

The payload does not matter. Quick presses that arrive while a change is still being sent are added
together into one change. "The whole group" (the default since 0.3.1) changes every room grouped with the
chosen room, keeping their balance; a room playing alone is its own group. "This room only" changes just the
chosen room (a home theatre with surrounds and Sub counts as one room). A speaker typed as an IP address and
not looked up is controlled on its own, since the Shard does not know its group.

With "Volume keys also unmute" on (the default), a volume key in group mode also unmutes every room of the
group that was muted on its own (in the Sonos app, say): Sonos keeps such a room muted when the group volume
changes, and counts the group as muted only when every room is. The activity log names the rooms unmuted.

**The volume bar (Sonos tab).** Drag it to set the volume of the room, or of the whole group in group mode:
the number follows at once and the volume is set when you let go, never past the maximum volume, unmuting as
the volume keys do. It goes through the same queue as the keys, so a key press and a drag never cross.

**Each room's own volume (Sonos tab).** While the chosen room is grouped, the Volume card lists every room in
the group with a slider for that room's own volume (a dash when it is muted, as on the TV's card). Letting go
of a slider sets that room's volume, never past the maximum volume, and unmutes it when "Volume keys also
unmute" is on. Only rooms in the chosen room's group can be set this way. The rooms are read again when the
page refreshes and after each volume key.

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

## Control center card (Vetro 0.7.0)

The Shard adds a **Sonos** card to the Control center of Vetro's launcher (Down on the apps row). Turn it on
in **Vetro UI → Launcher → Control center**; it is off until you choose it, and it shows only while this
Shard is on and Vetro's own launcher is in use.

```
Sonos
  ● 24  Salongen        (the TV speaker: the room chosen in the Sonos tab)
  ○ 12  Badrum
  ● 18  Kontor          (plays the TV sound with Salongen)
  ○  –  Kök             (muted)
```

- **What the rows show:** one row per room. A filled circle (●) means the room plays the TV sound, an empty
  one (○) that it does not. Then the room's own volume (a dash when it is muted, blank when it does not
  answer), then its name. The TV speaker, the room chosen in the Sonos tab, comes first; the other rooms
  follow in name order. The rows keep their place when the grouping changes, so OK twice on the same row adds
  a room and takes it out again. At most 7 rows.
- **What OK does:** OK on another room adds it to the TV speaker's group, so it plays the TV sound too (and
  stops what it played before), or takes it out of the group again: whichever its circle showed. The Shard
  reads the grouping first and changes nothing if the speakers do not answer. OK on the TV speaker changes
  nothing; the card opens with the cursor on it.
- **Layout:** Vetro's launcher draws each row as one line of text in the TV's font, SamsungOneUI 400, where
  digits are not all equally wide ("1" is narrower than "0") and some pairs are kerned. So the circle and the
  volume come first, and the space between them is made of space characters of known widths (hair, thin,
  six-per-em, en, ...), chosen per volume so that every name starts in the same column, within about a pixel.
  The table is generated from the font's own widths (`scripts/card-layout.cjs`, from `card-metrics.json`).
  When a room is at 100, every row leaves room for three digits. No row is ticked: Vetro ignores OK on a
  ticked row, so the launcher's own tick could not show a room that OK can take out again.
- **The note** (the grey line under the title) is only for a problem, such as *No answer from the speakers*
  or *TV speaker follows another room* (the TV speaker is part of another room's group: change that in the
  Sonos app). It stays within 33 characters, about what the launcher shows on a 2022 The Frame.
- The volume is shown, not changed: the Control center gives a card OK only, and Left and Right move
  between the cards. The remote's volume keys keep working as before.
- The card shows the volume as it was when the Control center opened (or after the last OK on it). Vetro
  0.7.0 reads a Shard's card only then, and gives a Shard no way to ask for a new reading, so a volume key
  pressed while the card is open shows the next time it opens.
- Opening the card only reads (the grouping, and each room's volume and mute). A change is sent only for
  the room you press OK on, and the activity log in the Sonos tab lists it.

**Choosing the TV speaker on the card (0.3.1).** Before a room is chosen, the card sets one up instead:

```
Sonos
  Search again
  ○ Badrum
  ○ Kontor
  ○ Kök
  ○ Salongen
```

- **What the rows show:** the first row is always the search (*Search for speakers* until one has run).
  Below it come the rooms of the last search, or of a lookup in the Sonos tab, in name order (at most 6).
- **What OK does:** OK on the search row searches the network for Sonos speakers (the same SSDP search as
  the Sonos tab, up to 8 seconds) and lists the rooms found; when nothing answers, the note says *No speakers
  found: add one by IP* (type its address in the Sonos tab). OK on a room makes it the TV speaker, saved as if
  you chose it in the Sonos tab, and the card turns into the normal card above at once, with no command sent
  to any speaker. The cursor stays on the same row number, which is now another room: OK there adds that
  room to the TV sound.
- Opening the card only reads what the Shard already knows: it never searches by itself.
- The same rows show for a speaker typed as an IP address without looking it up (the Shard does not know its
  rooms then). OK on the search row asks that speaker first; OK on its room saves the room with it.

## Permissions

None. It runs no commands.

## Network

- **Listens** on `127.0.0.1` (TCP, port 1883 by default) for Vetro's MQTT connection. Only programs on
  the TV can reach it. An optional user name and password can be required.
- **Connects** to the Sonos speakers on your local network, HTTP port 1400: reads and sets volume and
  mute, and reads which rooms exist and how they are grouped. From the Control center card it also adds a
  room to the TV speaker's group or takes it out (`SetAVTransportURI` with `x-rincon:<TV speaker>`, and
  `BecomeCoordinatorOfStandaloneGroup`, on that room's player). Nothing else is sent to them.
- **Speakers on the home network only.** The Shard sends requests only to a private IPv4 address:
  `10.x.x.x`, `172.16.x.x` to `172.31.x.x` or `192.168.x.x`, written as four plain numbers, and only on
  port 1400, the port Sonos fixes in its firmware (writing `:1400` is allowed; any other port is refused, so
  a speaker's answer cannot point the Shard at another service on a home-network machine). This applies to every address, however it arrives: typed in the Sonos tab, found by
  the network search, listed by a speaker for the other rooms, or saved in `config.json` by an older
  version. Everything else is refused before anything is sent to it, and the Sonos tab says why:
  - the TV itself: `127.x.x.x` and `localhost` (Vetro's own service listens there), and `0.0.0.0`;
  - host names such as `sonos.local`, and numbers written with leading zeros;
  - public addresses and other ranges, such as `100.64.x.x`;
  - any port other than 1400, such as `192.168.1.20:8080`;
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

On a computer, with Vetro's own MQTT client and bridge (from Vetro 0.7.0) connected to the receiver and a
simulated Sonos player that checks each request against the action and argument names in a real player's
service descriptions. The Sonos commands were also sent to a real Playbar (grouped with another room) and
read back: room and group volume, mute and unmute all worked, and room mode left the other room untouched.

On a 2022 The Frame (TQ55LS03BGUXXC) with Remote interception on the infrared remote ("wt61p807 rc device",
codes 68, 67 and 66), reported by the owner:

- Vetro 0.5.0 (Node 12.16), Shard 0.2.4: volume up, volume down and mute from the remote control a Sonos
  Playbar.
- Vetro 0.7.0, Shard 0.2.5: volume up, volume down and mute tried, and it has run without problems since.
- Vetro 0.7.0, Shard 0.3.1, with a Playbar and two other rooms:
  - the Control center card, with the circles, volumes and room names lining up as intended;
  - OK on a room adds it to the TV speaker's group and takes it out again;
  - setup on the card after a fresh install: the network search (SSDP) found the speakers, and OK on a room
    made it the TV speaker;
  - the new defaults after a fresh install (whole group, step 3);
  - a volume key in group mode unmutes a grouped room that was muted on its own;
  - the Sonos tab's per-room sliders.

Not tested on the TV: remotes other than the infrared one, and the Volume bar messages of Check Vetro
setup.
