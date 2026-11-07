import { getIceServers, Signal } from "/common.js";

const QUALITY = {
  "720p30": { width: 1280, height: 720, fps: 30, bitrate: 2_500_000 },
  "1080p30": { width: 1920, height: 1080, fps: 30, bitrate: 5_000_000 },
  "1080p60": { width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 },
  "1440p30": { width: 2560, height: 1440, fps: 30, bitrate: 10_000_000 },
  "1440p60": { width: 2560, height: 1440, fps: 60, bitrate: 15_000_000 },
  "2160p30": { width: 3840, height: 2160, fps: 30, bitrate: 20_000_000 },
  "2160p60": { width: 3840, height: 2160, fps: 60, bitrate: 30_000_000 },
};

const $ = (id) => document.getElementById(id);
const peers = new Map(); // viewer id -> RTCPeerConnection
let stream, signal, ice, quality;

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

if (QUALITY[saved.quality]) $("quality").value = saved.quality;
const showUploadHint = () => {
  const mbps = QUALITY[$("quality").value].bitrate / 1_000_000;
  $("upload-hint").textContent = `Uses up to ~${mbps} Mbps of your upload per viewer (3 viewers ≈ ${mbps * 3} Mbps).`;
};
$("quality").onchange = showUploadHint;
showUploadHint();

$("room").oninput =() => ($("room").value = $("room").value.toLowerCase().replace(/[^a-z0-9-]/g, ""));

$("setup").onsubmit = async (e) => {
  e.preventDefault();
  $("error").classList.add("hidden");
  const room = $("room").value;
  const password = $("password").value;
  quality = QUALITY[$("quality").value];
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: quality.width }, height: { ideal: quality.height }, frameRate: { ideal: quality.fps } },
      audio: true,
      systemAudio: "include",
      selfBrowserSurface: "exclude",
    });
  } catch (err) {
    if (err.name !== "NotAllowedError") showError(`Couldn't capture the screen: ${err.message}`);
    return;
  }
  const video = stream.getVideoTracks()[0];
  if (quality.fps >= 60) video.contentHint = "motion";
  video.onended = stop;

  ice = await getIceServers();
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
  save(Object.assign(saved, { room, quality: $("quality").value }));
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
    pc.addTransceiver(track, init);
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
  updateCount();
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
