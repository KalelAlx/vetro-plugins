# WLED Screen Sync

Samples TV picture colors and sends them to a configured WLED controller over DDP (UDP 4048). Configure the controller's IPv4 address under WLED target. The loopback default keeps output on the TV until configured. The default strip count is 538. Full-picture capture depends on firmware and input mode. The color sampler can provide lower resolution fallback.

The predecessor, Ambilight 538, ran on a Samsung QN55QN85BAFXZC. The renamed catalog build has not been tested on a TV. Game Mode and source switching can make full-picture capture unavailable.

## Commands it runs

- `systemctl is-active`, `stop`, `restart`, and `reset-failed` manage the shard's capture service. `systemd-run` runs the bundled helper under `/usr/bin/dotnet`.
- `cat` reads the helper's capture statistics.
- `busctl` queries HDR status from the TV's AV output service.
- `curl` checks the configured WLED controller's `/json/info` when requested.

The helper sources are included beside the payload. Compile Colour.cs, VideoPlaneCapture.cs and Tuning.cs together with Roslyn using the Tizen .NET API 9 reference assemblies and the `-unsafe -optimize+` flags, then base64-encode Colour.exe into payload.b64.
