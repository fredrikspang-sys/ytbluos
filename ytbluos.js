#!/usr/bin/env node
// ytbluos: cast YouTube / YouTube Music from the phone app to a BluOS player (Opus in Ogg or AAC m4a, via yt-dlp).
import http from "node:http"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import dgram from "node:dgram";
import { spawn, spawnSync } from "node:child_process"; import { pipeline } from "node:stream"; import { parseArgs } from "node:util";
import YouTubeCastReceiver, { Player, PLAYER_STATUSES } from "yt-cast-receiver";
import mdns from "multicast-dns";

const { values: a } = parseArgs({ options: Object.fromEntries(["player", "name", "cookies", "cache", "ip", "port", "dial-port", "play"]
  .map(k => [k, { type: "string" }]).concat([["help", { type: "boolean", short: "h" }]])) });
const env = (k) => process.env["YTBLUOS_" + k.toUpperCase().replace("-", "_")];
const cfg = (k, d) => a[k] ?? env(k) ?? d;
if (a.help) { console.log(`Usage: ytbluos [--player host[:port]] [--name NAME] [--cookies FILE] [--cache DIR] [--ip LAN_IP]
  [--port 8098] [--dial-port 8099] [--play VIDEO_ID]   (or env YTBLUOS_PLAYER, YTBLUOS_NAME, ...; YTDLP=path to yt-dlp)`); process.exit(0); }
const ts = () => new Date().toLocaleTimeString("sv");
const log = (...m) => console.log(ts(), ...m);

// BluOS player: --player, else first one found via mDNS (_musc._tcp).
const discover = () => new Promise((ok, fail) => {
  const m = mdns(), t = setTimeout(() => { m.destroy(); fail(new Error("No BluOS player found via mDNS; use --player host[:port]")); }, 5000);
  m.on("response", (r, rinfo) => {
    const recs = [...r.answers, ...r.additionals].filter(x => x.name.endsWith("_musc._tcp.local"));
    if (recs.length) { clearTimeout(t); m.destroy(); ok(`${rinfo.address}:${recs.find(x => x.type === "SRV")?.data.port ?? 11000}`); }
  });
  m.query("_musc._tcp.local", "PTR");
});
let player_ = cfg("player") ?? await discover(); if (!player_.includes(":")) player_ += ":11000";
const [pHost, pPort] = player_.split(":"), BLUOS = `http://${player_}`;
// LAN IP to advertise: the local address that routes to the player.
const IP = cfg("ip") ?? await new Promise((ok, fail) => { const s = dgram.createSocket("udp4");
  s.connect(+pPort, pHost, (e) => { if (e) fail(e); else { ok(s.address().address); s.close(); } }); });
const PORT = +cfg("port", 8098), NAME = cfg("name", os.hostname().split(".")[0]), COOKIES = cfg("cookies");
const CACHE = cfg("cache", path.join(os.homedir(), ".cache", "ytbluos"));
fs.mkdirSync(CACHE, { recursive: true }); process.chdir(CACHE); // receiver session state (.node-persist) lives here too

const bluos = async (p) => (await fetch(BLUOS + p, { signal: AbortSignal.timeout(5000) })).text();
const tag = (xml, t) => xml.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1];

// Download (or reuse) the best audio BluOS can play: <id>.m4a with 141 = 256k AAC (Premium), 140 = 128k AAC, or other AAC
// (e.g. 140-drc on multi-language videos); opt-in 774 = 256k Opus (<id>.webm, streamed as Ogg via ffmpeg, see below).
// yt-dlp's normal m4a fixup must run: the raw DASH m4a has no sample tables, so BluOS shows no length and seeks restart from 0.
// Resolves to the duration in s once the file is complete.
const FFMPEG = process.env.FFMPEG || "ffmpeg", OPUS = process.env.YTBLUOS_OPUS !== "0" && spawnSync(FFMPEG, ["-version"]).status === 0; // Opus first unless YTBLUOS_OPUS=0
const inflight = new Map(); // id -> ready promise
const fetchAudio = (id) => inflight.get(id) ?? dl(id);
const dl = (id) => {
  const f = (ext) => path.join(CACHE, `${id}.${ext}`);
  if (["webm", "m4a"].some(e => fs.existsSync(f(e))) && fs.existsSync(f("dur"))) return Promise.resolve(Number(fs.readFileSync(f("dur"), "utf8")));
  const p = new Promise((ok, fail) => {
    let out = "";
    const y = spawn(process.env.YTDLP || "yt-dlp", ["-q", "--no-warnings", "--no-simulate", ...(COOKIES ? ["--cookies", COOKIES] : []),
      "-f", `${OPUS ? "774/" : ""}141/140/bestaudio[ext=m4a]`, "-o", f("%(ext)s"), "--print", "%(format_id)s %(duration)s %(ext)s", `https://music.youtube.com/watch?v=${id}`]);
    y.stdout.on("data", (d) => out += d);
    y.on("error", fail);
    y.on("close", (code) => {
      const [fmt, d2, ext] = out.trim().split(" "), dur = Number(d2);
      const fin = (err) => {
        inflight.delete(id);
        if (err) { for (const e of ["m4a", "webm"]) try { fs.rmSync(f(e), { force: true }); } catch {} return fail(err); }
        fs.writeFileSync(f("dur"), String(dur)); log(`downloaded ${id} format=${fmt} (${ext}) dur=${dur}s`);
        fs.readdirSync(CACHE).filter(x => /\.(m4a|webm|dur)$/.test(x)).map(x => path.join(CACHE, x))
          .sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs).slice(60).forEach(x => { try { fs.unlinkSync(x); } catch {} });
        ok(dur);
      };
      fin(code || !dur ? new Error(`yt-dlp failed for ${id} (exit ${code})`) : null);
    });
  });
  inflight.set(id, p); p.catch(() => {}); return p;
};

// Audio server with Range support (BluOS seeks with Range requests).
http.createServer((req, res) => {
  const [, id, ext] = (req.url || "").match(/^\/yt\/([\w-]{11})\.(m4a|ogg)/) || [], f = path.join(CACHE, `${id}.${ext}`);
  if (ext === "ogg") { // Opus: BluOS plays it in Ogg (not WebM) but can't seek it, so remux the WebM on the fly from ?t= seconds
    const w = path.join(CACHE, `${id}.webm`), t = Number(new URL(req.url, "http://x").searchParams.get("t")) || 0;
    if (!fs.existsSync(w)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": "audio/ogg" }); if (req.method === "HEAD") return res.end();
    const ff = spawn(FFMPEG, ["-v", "error", "-i", w, "-ss", String(t), "-c:a", "copy", "-avoid_negative_ts", "make_zero", "-f", "ogg", "pipe:1"]); // -ss after -i: packet-accurate
    return pipeline(ff.stdout, res, () => ff.kill());
  }
  if (!id || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  const size = fs.statSync(f).size, m = (req.headers.range || "").match(/bytes=(\d*)-(\d*)/);
  const start = m?.[1] ? +m[1] : 0, end = Math.min(m?.[2] ? +m[2] : size - 1, size - 1);
  res.writeHead(m ? 206 : 200, { "Content-Type": ext === "ogg" ? "audio/ogg" : "audio/mp4", "Accept-Ranges": "bytes", "Content-Length": end - start + 1,
    ...(m ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) });
  if (req.method === "HEAD") return res.end();
  pipeline(fs.createReadStream(f, { start, end }), res, () => {}); // closes the file even if the player disconnects
}).listen(PORT, IP);

class BluOSPlayer extends Player {
  url = ""; vid = ""; dur = 0; secs = 0; off = 0; busy = false; gen = 0; // off: start of an Opus stream (?t=), added to the NAD's secs
  constructor() { super(); setInterval(() => void this.watch(), 1000); }
  src(id, t) { const ogg = fs.existsSync(path.join(CACHE, `${id}.webm`)); this.vid = id; this.off = ogg ? Math.floor(t) : 0;
    return this.url = `http://${IP}:${PORT}/yt/${id}.${ogg ? `ogg?t=${this.off}` : "m4a"}`; }
  async ours() { return this.url !== "" && tag(await bluos("/Status"), "streamUrl") === this.url; }
  async doPlay(video, position) {
    this.busy = true; const g = ++this.gen;
    try {
      const dur = await fetchAudio(video.id);
      if (g !== this.gen) return false; // stopped or replaced while downloading
      this.dur = dur; await bluos(`/Play?url=${encodeURIComponent(this.src(video.id, position))}`);
      if (position > 1 && !this.off) await bluos(`/Play?seek=${Math.floor(position)}`);
      this.secs = position; const ids = this.queue.videoIds, nextId = ids[ids.indexOf(video.id) + 1];
      if (nextId) fetchAudio(nextId).catch(() => {}); // prefetch so the next track starts without a gap
      log(`playing ${video.id} from ${position}s`); return true;
    } catch (e) { log("play failed", e); return false; } finally { setTimeout(() => this.busy = false, 4000); }
  }
  async doPause() { if (await this.ours()) await bluos("/Pause"); return true; }
  async doResume() { await bluos("/Play"); return true; }
  async doStop() { this.gen++; if (await this.ours()) await bluos("/Stop"); this.url = ""; return true; }
  async doSeek(p) {
    log(`seek to ${Math.floor(p)}s`); if (!this.url.includes(".ogg")) { this.secs = Math.floor(p); await bluos(`/Play?seek=${this.secs}`); return true; }
    this.busy = true; await bluos(`/Play?url=${encodeURIComponent(this.src(this.vid, p))}`); this.secs = this.off; setTimeout(() => this.busy = false, 4000); return true;
  }
  async doSetVolume(v) { await bluos(`/Volume?level=${v.level}`); await bluos(`/Volume?mute=${v.muted ? 1 : 0}`); return true; }
  async doGetVolume() { const s = await bluos("/Status"); return { level: Number(tag(s, "volume")), muted: tag(s, "mute") === "1" }; }
  // Report our own position; refresh it from the player only once it plays our current URL (right after a seek or play
  // the player still reports the old stream, which made the phone jump back).
  async doGetPosition() {
    const s = await bluos("/Status");
    if (!this.busy && this.url && tag(s, "streamUrl") === this.url) this.secs = this.off + Number(tag(s, "secs") || 0);
    return this.url ? this.secs : 0;
  }
  async doGetDuration() { return this.dur; }
  // BluOS resumes its own queue when a /Play?url stream ends, so advance ~2s before the end ourselves.
  async watch() {
    if (this.busy || this.status !== PLAYER_STATUSES.PLAYING) return;
    try {
      const s = await bluos("/Status"), secs = this.off + Number(tag(s, "secs") || 0), len = (!this.off && Number(tag(s, "totlen"))) || this.dur;
      if (tag(s, "streamUrl") === this.url) { this.secs = secs; if (len > 0 && secs >= len - 2) await this.advance(); }
      else if (this.secs >= this.dur - 6) await this.advance(); // ended just before we noticed
      else { log("player taken over by another source, cast stopped"); this.url = ""; await this.notifyExternalStateChange(PLAYER_STATUSES.STOPPED); }
    } catch (e) { log("status poll failed", e.message); }
  }
  async advance() {
    this.busy = true; log("track ended -> next");
    if (!(await this.next())) { this.busy = false; this.url = ""; await this.notifyExternalStateChange(PLAYER_STATUSES.STOPPED); }
  }
}

const player = new BluOSPlayer();
const receiver = new YouTubeCastReceiver(player, { dial: { port: +cfg("dial-port", 8099), bindToAddresses: [IP] },
  device: { name: NAME, screenName: `YouTube on ${NAME}`, brand: "ytbluos", model: "BluOS bridge" }, logLevel: "warn" });
receiver.on("senderConnect", s => log(`sender connected: ${s.name}`));
receiver.on("senderDisconnect", s => log(`sender disconnected: ${s.name}`));
receiver.on("error", e => log("error", e));
const quit = async () => { await player.stop().catch(() => {}); await receiver.stop().catch(() => {}); process.exit(0); };
process.on("SIGINT", quit); process.on("SIGTERM", quit);
await receiver.start();
log(`ready: cast to "${NAME}" | BluOS ${BLUOS} | audio http://${IP}:${PORT} | cache ${CACHE}`);
if (a.play) await player.play({ id: a.play, client: {} }, 0); // test playback without a phone
