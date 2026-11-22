# Ambilight Studio

Samples TV picture colors and sends them to a configured WLED controller over DDP (UDP 4048). Configure the controller's IPv4 address under WLED target. The loopback default keeps output on the TV until configured. The default strip count is 538. Full-picture capture depends on firmware and input mode. The color sampler can provide lower resolution fallback.

The predecessor, Ambilight 538, ran on a Samsung QN55QN85BAFXZC. Version 0.3.3 was installed and reported running on this TV. Game Mode and source switching can make full-picture capture unavailable.

## Dashboard and discovery

Find WLED controllers sends one local mDNS query for the WLED service. Select an advertisement and apply settings to change the destination. Manual IPv4 entry works when multicast is unavailable. Discovery was verified on a LAN with two controllers.

The strip monitor shows 48 samples from outgoing DDP packets in physical LED order. It refreshes once per second and clears stale output. It shows the transmitted colors, without feedback from the LEDs. Capture diagnostics show scan rate, observed changes, active zones and crop insets.

Color accent picks the depth sample with the strongest chroma. Highlight picks the highest luma. With the fallback sampler, both choose among measured spots on each side (four-spot mode has only one choice per side). One color per side averages each entire edge. Whole-strip average produces one color for all LEDs.

## Output and strip layout

Simple view provides daily lighting controls. Advanced view adds capture diagnostics and per-side LED counts and switches. Output supports 1–4096 RGB pixels over DDP or WLED DNRGB. Screen sync samples up to 538 zones.

The available modes are Screen sync, Screen + TV audio, and TV audio sync. TV audio sync captures the TV PCM output locally and generates reactive LED colors. Screen + TV audio combines picture and live audio by changing intensity only; it never replaces screen colors with an audio palette. Audio sampling offers impact/peaks, balanced, and music/rhythm profiles.

## Commands it runs

- `systemctl is-active`, `stop`, `restart`, and `reset-failed` manage the shard's capture service. `systemd-run` runs the bundled helper under `/usr/bin/dotnet`.
- `cat` reads capture statistics and preview samples. `stat` and `date` check preview freshness.
- `busctl` queries HDR status from the TV's AV output service.
- `arecord` captures TV audio from the TV PCM dump device `hw:0,5` for TV audio sync.
- WLED HTTP `/json/info` uses port 80 without a shell command. UDP output uses DDP port 4048 or WLED DNRGB port 21324.
- The helper runs as root and reads the video plane through Samsung private libraries (`libvideo-capture`, `libvideoenhance`) plus vconf `memory/system/source_type`.
- The helper is 32-bit-only. It refuses 64-bit runtimes before native pointer access.
- Runtime files are kept below this Shard's private `runtime/` directory: `rate.txt`, `preview.b64`, and HDR state. The directory is 0700 and symlinks are refused.

## Building the helper

Use the pinned SDK 8.0.100:

```
node scripts/build-wled-screen-sync-helper.cjs
node scripts/build-wled-screen-sync-helper.cjs --check
```

The build compiles `Colour.cs`, `VideoPlaneCapture.cs`, and `Tuning.cs` through `helpers/wled-screen-sync/WledScreenSync.csproj`, then writes `payload.b64`, `Colour.runtimeconfig.json`, and `Colour.deps.json` beside the Shard source. CI rebuilds the helper and compares the generated DLL SHA-256 to the embedded payload.
