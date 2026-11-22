# Ambilight Studio

Samples TV picture colors and sends them to a configured WLED controller over DDP (UDP 4048). Configure the controller's IPv4 address under WLED target. The loopback default keeps output on the TV until configured. The default strip count is 538. Full-picture capture depends on firmware and input mode. The color sampler can provide lower resolution fallback.

The predecessor, Ambilight 538, ran on a Samsung QN55QN85BAFXZC. Version 0.3.3 was installed and reported running on this TV. Game Mode and source switching can make full-picture capture unavailable.

## Dashboard and discovery

Find WLED controllers sends one local mDNS query for the WLED service. Select an advertisement and apply settings to change the destination. Manual IPv4 entry works when multicast is unavailable. Discovery was verified on a LAN with two controllers.

The strip monitor shows 48 samples from outgoing DDP packets in physical LED order. It refreshes once per second and clears stale output. It shows the transmitted colors, without feedback from the LEDs. Capture diagnostics show scan rate, observed changes, active zones and crop insets.

Color accent picks the depth sample with the strongest chroma. Highlight picks the highest luma. With the fallback sampler, both choose among measured spots on each side (four-spot mode has only one choice per side). One color per side averages each entire edge. Whole-strip average produces one color for all LEDs.

## Output and strip layout

Simple view provides daily lighting controls. Advanced view adds capture diagnostics and per-side LED counts and switches. Output supports 1–4096 RGB pixels over DDP or WLED DNRGB. Screen sync samples up to 538 zones.

Screen sync, Audio sync and Solid are grouped separately from Twinkle, Rolling wave, Fireflies, Breathe and Comet trail. Audio sync activates Freqwave on the selected WLED controller and uses its audio input or sync feed. The shard does not capture TV or HDMI audio.

## Commands it runs

- `systemctl is-active`, `stop`, `restart`, and `reset-failed` manage the shard's capture service. `systemd-run` runs the bundled helper under `/usr/bin/dotnet`.
- `cat` reads capture statistics and preview samples. `stat` and `date` check preview freshness.
- `busctl` queries HDR status from the TV's AV output service.
- `curl` queries the selected controller and sets its effect through the WLED JSON API when audio sync is selected.

The helper sources are included beside the payload. Compile Colour.cs, VideoPlaneCapture.cs and Tuning.cs together with Roslyn using the Tizen .NET API 9 reference assemblies and the `-unsafe -optimize+` flags, then base64-encode Colour.exe into payload.b64.
