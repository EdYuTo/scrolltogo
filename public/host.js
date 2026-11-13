import { getIceServers, Signal } from "/common.js";

// Bitrate at 30 fps. More frames need more bits, but not proportionally,
// since consecutive frames are more alike the faster they come.
const RESOLUTIONS = {
  "720p": { width: 1280, height: 720, bitrate: 2_500_000 },
  "1080p": { width: 1920, height: 1080, bitrate: 5_000_000 },
  "1440p": { width: 2560, height: 1440, bitrate: 10_000_000 },
  "2160p": { width: 3840, height: 2160, bitrate: 20_000_000 },
};
const FPS_BITRATE_FACTOR = { 30: 1, 60: 1.6, 120: 2.5, 240: 4 };

const $ = (id) => document.getElementById(id);

function selectedQuality() {
  const fps = Number($("fps").value);
  const res = RESOLUTIONS[$("resolution").value];
  return { ...res, fps, bitrate: Math.round(res.bitrate * FPS_BITRATE_FACTOR[fps]) };
}
const peers = new Map(); // viewer id -> RTCPeerConnection
let stream, signal, ice, quality, codec, statsTimer;

// This browser's token proves it owns the rooms it created. The last room name
// is remembered so the same link can be reused and bookmarked by friends.
const saved = loadSaved();
$("origin").textContent = `${location.host}/w/`;
$("room").value = saved.room;

function loadSaved() {
  let data;
  try {
    data = JSON.parse(localStorage.getItem("host"));
  } catch {}
  if (!data?.token) data = { token: randomId(32), room: randomId(8) };
  save(data);
  return data;
}

function save(data) {
  try {
    localStorage.setItem("host", JSON.stringify(data));
  } catch {}
}

function randomId(length) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) => chars[b % chars.length]).join("");
}

// Older versions saved one "quality" value like "1440p60".
const oldQuality = /^(\d+p)(\d+)$/.exec(saved.quality ?? "");
if (oldQuality && !saved.resolution) Object.assign(saved, { resolution: oldQuality[1], fps: oldQuality[2] });

// Saved as "encoder": an older version stored an AV1 default under "codec".
for (const [key, id] of [["resolution", "resolution"], ["fps", "fps"], ["content", "content"], ["encoder", "codec"]]) {
  if (saved[key] && [...$(id).options].some((o) => o.value === saved[key])) $(id).value = saved[key];
}
const showUploadHint = () => {
  const { bitrate, fps } = selectedQuality();
  const mbps = Math.round(bitrate / 100_000) / 10;
  $("upload-hint").textContent =
    `Uses up to ~${mbps} Mbps of your upload per viewer (3 viewers ≈ ${Math.round(mbps * 3)} Mbps).` +
    (fps > 60 ? ` Friends see at most as many fps as their monitor's refresh rate.` : "");
};
const showCodecHint = async () => {
  const choice = await resolveCodec($("codec").value, selectedQuality());
  $("codec-hint").textContent = `→ ${choice.mime.slice(6)}${choice.hardware ? " (hardware encoder)" : " (software encoder)"}`;
};
$("resolution").onchange = $("fps").onchange = () => (showUploadHint(), showCodecHint());
$("codec").onchange = showCodecHint;
showUploadHint();
showCodecHint();

// A codec with a hardware encoder (GPU) keeps the fps up without loading the CPU,
// which matters because every viewer gets their own encode. "Auto" prefers the
// best-compressing codec the GPU can encode, otherwise a light software one.
async function resolveCodec(choice, q) {
  const available = new Set(RTCRtpSender.getCapabilities("video").codecs.map((c) => c.mimeType));
  const hardware = async (mime) => {
    try {
      const info = await navigator.mediaCapabilities.encodingInfo({
        type: "webrtc",
        video: { contentType: mime, width: q.width, height: q.height, bitrate: q.bitrate, framerate: q.fps },
      });
      return info.supported && info.powerEfficient;
    } catch {
      return false;
    }
  };
  if (choice !== "auto") return { mime: available.has(choice) ? choice : "video/VP8", hardware: await hardware(choice) };
  for (const mime of ["video/AV1", "video/H264", "video/VP9"]) {
    if (available.has(mime) && (await hardware(mime))) return { mime, hardware: true };
  }
  // No GPU encoder: VP9 compresses well but is CPU-heavy, so use H.264 above 1080p30.
  const heavy = q.width * q.height * q.fps > 1920 * 1080 * 30;
  const mime = !heavy && available.has("video/VP9") ? "video/VP9" : available.has("video/H264") ? "video/H264" : "video/VP8";
  return { mime, hardware: false };
}

function preferCodec(transceiver, mime) {
  const codecs = RTCRtpReceiver.getCapabilities("video").codecs;
  const first = codecs.filter((c) => c.mimeType === mime);
  if (!first.length) return;
  try {
    // The viewer's browser falls back down this list if it can't decode the first one.
    transceiver.setCodecPreferences([...first, ...codecs.filter((c) => c.mimeType !== mime)]);
  } catch {}
}

$("room").oninput =() => ($("room").value = $("room").value.toLowerCase().replace(/[^a-z0-9-]/g, ""));

$("setup").onsubmit = async (e) => {
  e.preventDefault();
  $("error").classList.add("hidden");
  const room = $("room").value;
  const password = $("password").value;
  quality = selectedQuality();
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: quality.width }, height: { ideal: quality.height }, frameRate: { ideal: quality.fps, max: quality.fps } },
      audio: true,
      systemAudio: "include",
      selfBrowserSurface: "exclude",
    });
  } catch (err) {
    if (err.name !== "NotAllowedError") showError(`Couldn't capture the screen: ${err.message}`);
    return;
  }
  const video = stream.getVideoTracks()[0];
  // Chrome treats screen shares as text by default and drops fps to keep them
  // sharp. "motion" makes it lower resolution instead, which suits games/video.
  video.contentHint = $("content").value;
  video.onended = stop;
  // Chrome caps screen capture at 30 fps unless asked for more explicitly.
  try {
    await video.applyConstraints({ frameRate: { ideal: quality.fps, max: quality.fps } });
  } catch {}

  codec = (await resolveCodec($("codec").value, quality)).mime;
  ice = await getIceServers();
  clearInterval(statsTimer);
  statsTimer = setInterval(refreshStats, 2000);
  $("preview").srcObject = stream;
  $("link").value = `${location.origin}/w/${room}`;
  $("setup").classList.add("hidden");
  $("live").classList.remove("hidden");
  updateCount();

  signal = new Signal(`/ws/${room}`, {
    auth: { role: "host", token: saved.token, password },
    onMessage,
    onEnd: (e) => {
      stop();
      showError(e.reason || "Disconnected from the room.");
    },
  });
  save(Object.assign(saved, { room, resolution: $("resolution").value, fps: $("fps").value, content: $("content").value, encoder: $("codec").value }));
};

function onMessage(msg) {
  if (msg.type === "hello") {
    // (Re)connected: drop viewers that left meanwhile, call the ones we don't have.
    for (const id of peers.keys()) if (!msg.viewers.includes(id)) closePeer(id);
    for (const id of msg.viewers) {
      const pc = peers.get(id);
      if (!pc || ["failed", "closed"].includes(pc.connectionState)) callViewer(id);
    }
  } else if (msg.type === "viewer-joined") {
    callViewer(msg.id);
  } else if (msg.type === "viewer-left") {
    closePeer(msg.id);
  } else if (msg.type === "signal") {
    const pc = peers.get(msg.from);
    if (!pc) return;
    if (msg.data.sdp) {
      const sdp = withStartBitrate(msg.data.sdp.sdp, Math.min(quality.bitrate / 2, 10_000_000) / 1000);
      pc.setRemoteDescription({ type: msg.data.sdp.type, sdp }).catch(console.warn);
    }
    if (msg.data.candidate) pc.addIceCandidate(msg.data.candidate).catch(() => {});
    if (msg.data.retry) callViewer(msg.from);
  }
}

async function callViewer(id) {
  closePeer(id);
  const pc = new RTCPeerConnection({ iceServers: ice });
  peers.set(id, pc);

  for (const track of stream.getTracks()) {
    const init = { direction: "sendonly", streams: [stream] };
    if (track.kind === "video") init.sendEncodings = [{ maxBitrate: quality.bitrate, maxFramerate: quality.fps }];
    const transceiver = pc.addTransceiver(track, init);
    if (track.kind === "video") preferCodec(transceiver, codec);
  }
  pc.onicecandidate = (e) => e.candidate && signal.send({ type: "signal", to: id, data: { candidate: e.candidate } });
  pc.onconnectionstatechange = updateCount;

  await pc.setLocalDescription(await pc.createOffer());
  signal.send({ type: "signal", to: id, data: { sdp: pc.localDescription } });
  updateCount();
}

// WebRTC starts around 300 kbps and ramps up slowly, which keeps high resolutions
// blurry for the first ~20 seconds. Chrome reads a start bitrate hint from the SDP.
function withStartBitrate(sdp, kbps) {
  const lines = sdp.split("\r\n");
  const video = lines.find((l) => l.startsWith("m=video"));
  if (!video) return sdp;
  for (const pt of video.split(" ").slice(3)) {
    const rtpmap = lines.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
    if (rtpmap < 0 || !/ (VP8|VP9|H264|AV1)\//.test(lines[rtpmap])) continue;
    const fmtp = lines.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
    const hint = `x-google-start-bitrate=${Math.round(kbps)}`;
    if (fmtp >= 0) lines[fmtp] += `;${hint}`;
    else lines.splice(rtpmap + 1, 0, `a=fmtp:${pt} ${hint}`);
  }
  return lines.join("\r\n");
}

function closePeer(id) {
  peers.get(id)?.close();
  peers.delete(id);
  lastSample.delete(id);
  updateCount();
}

// Per-viewer stats with a plain-language guess at what's limiting the stream.
const lastSample = new Map();
async function refreshStats() {
  const settings = stream?.getVideoTracks()[0]?.getSettings() ?? {};
  const cards = [
    {
      title: "Your capture",
      numbers: `${settings.width ?? "?"}×${settings.height ?? "?"} · capturing at up to ${Math.round(settings.frameRate ?? 0)} fps (asked for ${quality.fps})`,
    },
  ];
  let n = 0;
  for (const [id, pc] of peers) {
    n++;
    const report = await pc.getStats();
    let out, source, remote, pairId;
    report.forEach((s) => {
      if (s.type === "outbound-rtp" && s.kind === "video") out = s;
      if (s.type === "media-source" && s.kind === "video") source = s;
      if (s.type === "remote-inbound-rtp" && s.kind === "video") remote = s;
      if (s.type === "transport") pairId = s.selectedCandidatePairId;
    });
    if (!out || pc.connectionState !== "connected") {
      cards.push({ title: `Friend ${n}`, numbers: "Connecting…" });
      continue;
    }
    const pair = report.get(pairId);
    const prev = lastSample.get(id);
    lastSample.set(id, { bytes: out.bytesSent, ts: out.timestamp });
    const mbps = prev ? ((out.bytesSent - prev.bytes) * 8) / (out.timestamp - prev.ts) / 1000 : 0;
    const codecName = report.get(out.codecId)?.mimeType?.slice(6) ?? "?";
    const encoder = out.powerEfficientEncoder === true ? "hardware" : out.powerEfficientEncoder === false ? "software" : "";
    const lossPct = (remote?.fractionLost ?? 0) * 100;
    const linkMbps = pair?.availableOutgoingBitrate ? pair.availableOutgoingBitrate / 1e6 : null;

    const problems = [];
    if (source?.framesPerSecond && source.framesPerSecond < quality.fps * 0.75) {
      problems.push(`Screen capture is only giving ${Math.round(source.framesPerSecond)} fps: the game is leaving the browser too little GPU/CPU. Cap the game's fps, and use borderless/windowed rather than exclusive fullscreen.`);
    }
    if (out.qualityLimitationReason === "cpu") {
      problems.push("Your computer can't encode fast enough. Try codec H.264, a lower quality, or fewer viewers.");
    } else if (out.qualityLimitationReason === "bandwidth") {
      problems.push(`Limited by the network${linkMbps ? ` (~${linkMbps.toFixed(1)} Mbps available)` : ""}: your upload or their download. Try a lower quality.`);
    }
    if (lossPct > 3) problems.push(`${lossPct.toFixed(0)}% of packets are being lost. Their Wi-Fi or connection is unstable.`);
    const advice = problems.length ? ["warn", problems.join(" ")] : ["ok", "Full quality."];
    cards.push({
      title: `Friend ${n}`,
      numbers: `${out.frameWidth ?? "?"}×${out.frameHeight ?? "?"} @ ${Math.round(out.framesPerSecond ?? 0)} fps · ${mbps.toFixed(1)} Mbps · ${codecName}${encoder ? ` (${encoder})` : ""}${pair?.currentRoundTripTime ? ` · ${Math.round(pair.currentRoundTripTime * 1000)} ms` : ""}`,
      advice,
    });
  }
  $("stats").replaceChildren(
    ...cards.map(({ title, numbers, advice }) => {
      const el = document.createElement("div");
      el.className = "viewer";
      el.innerHTML = `<strong></strong><span class="numbers"></span>${advice ? `<span class="${advice[0]}"></span>` : ""}`;
      el.children[0].textContent = title;
      el.children[1].textContent = numbers;
      if (advice) el.children[2].textContent = advice[1];
      return el;
    }),
  );
}

function updateCount() {
  const n = [...peers.values()].filter((pc) => pc.connectionState === "connected").length;
  $("count").textContent = `${n} watching`;
}

function stop() {
  if (!stream) return;
  for (const id of peers.keys()) signal?.send({ type: "signal", to: id, data: { bye: true } });
  for (const id of [...peers.keys()]) closePeer(id);
  stream.getTracks().forEach((t) => t.stop());
  stream = null;
  clearInterval(statsTimer);
  $("stats").replaceChildren();
  // Let the goodbye messages flush before closing the socket.
  const s = signal;
  signal = null;
  setTimeout(() => s?.stop(), 200);
  $("preview").srcObject = null;
  $("live").classList.add("hidden");
  $("setup").classList.remove("hidden");
}

$("stop").onclick = stop;

$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("link").value);
  } catch {
    $("link").select();
    document.execCommand("copy");
  }
  $("copy").textContent = "Copied!";
  setTimeout(() => ($("copy").textContent = "Copy link"), 1500);
};

function showError(text) {
  $("error").textContent = text;
  $("error").classList.remove("hidden");
}
