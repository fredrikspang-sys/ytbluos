# ytbluos

Cast YouTube and YouTube Music from the phone app to a BluOS player (Bluesound, NAD, ...).

ytbluos shows up as a cast device in the YouTube / YouTube Music apps (DIAL, like a smart TV).
When you cast, it downloads the track's audio with yt-dlp, serves it over HTTP on your LAN
and tells the BluOS player to play it. Play, pause, seek, skip and volume work from the phone,
and the next track is prefetched for gapless queue playback. The player's own queue is left intact.

**Platforms:** Linux, macOS and Windows. Tested on Slackware Linux 15.0, macOS and Windows 11.

## Requirements

- Node.js 22+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) on PATH (or set `YTDLP=/path/to/yt-dlp`)
- Optional: a YouTube Premium cookies file (Netscape format) for 256k audio; otherwise 128k AAC is used
- [ffmpeg](https://ffmpeg.org) on PATH (or `FFMPEG=/path/to/ffmpeg`): yt-dlp needs it to turn YouTube's raw DASH m4a into a normal m4a; without it BluOS shows no track length and cannot seek. Also used by the Opus mode.
- The computer, the BluOS player and the phone on the same LAN

Audio formats, best first: 774 (256k Opus, Premium), 141 (256k AAC, Premium), 140 (128k AAC), other AAC m4a. No re-encoding.
BluOS plays Opus only in Ogg and cannot seek it, so ytbluos remuxes the WebM to Ogg on the fly with ffmpeg (no re-encoding)
from the requested position; a seek starts a new stream. Set `YTBLUOS_OPUS=0` to use AAC only.

## Run

    npm install
    node ytbluos.js                       # finds the BluOS player via mDNS
    node ytbluos.js --player 192.0.2.10 --name livingroom --cookies ~/cookies.txt

Then pick the device (default: this computer's hostname) in the cast menu of the YouTube or YouTube Music app.
Test without a phone: `node ytbluos.js --play VIDEO_ID`.

| Flag | Env | Default |
|---|---|---|
| `--player host[:port]` | `YTBLUOS_PLAYER` | first `_musc._tcp` player found via mDNS, port 11000 |
| `--name` | `YTBLUOS_NAME` | hostname |
| `--cookies FILE` | `YTBLUOS_COOKIES` | none |
| `--cache DIR` | `YTBLUOS_CACHE` | `~/.cache/ytbluos` (keeps the 30 newest tracks) |
| `--ip` | `YTBLUOS_IP` | local address that routes to the player |
| `--port` / `--dial-port` | `YTBLUOS_PORT` / `YTBLUOS_DIAL_PORT` | 8098 / 8099 |

The firewall must allow inbound UDP 1900 (SSDP) and TCP 8098/8099 from the LAN.

## Autostart

- **Linux (cron):** `crontab -e` and add
  `@reboot sleep 30; cd $HOME/ytbluos && node ytbluos.js >> $HOME/ytbluos.log 2>&1`
  (use the full path to `node` if it is not in cron's PATH)
- **Linux (systemd):** see [autostart/ytbluos.service](autostart/ytbluos.service)
- **macOS (launchd):** see [autostart/ytbluos.plist](autostart/ytbluos.plist)
- **Windows (Task Scheduler):**
  `schtasks /create /tn ytbluos /sc onlogon /tr "node %USERPROFILE%\ytbluos\ytbluos.js"`
  (remove with `schtasks /delete /tn ytbluos /f`)

## Notes

- When a cast stream ends, BluOS resumes its own queue, so ytbluos starts the next cast track ~2 s early.
- Stopping ytbluos (Ctrl-C / SIGTERM) stops the player if it is playing a ytbluos stream.

## Built on

- [yt-cast-receiver](https://github.com/patrickkfkan/yt-cast-receiver) by patrickkfkan: the YouTube cast receiver (DIAL discovery and the YouTube Lounge protocol) that makes the computer show up in the YouTube and YouTube Music apps
- [multicast-dns](https://github.com/mafintosh/multicast-dns): finds BluOS players on the network
- [yt-dlp](https://github.com/yt-dlp/yt-dlp): fetches the audio from YouTube
- [ffmpeg](https://ffmpeg.org): fixes up the m4a files and repackages Opus as Ogg
- [Node.js](https://nodejs.org) 22 or newer

## License

MIT
