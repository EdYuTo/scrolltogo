import { getIceServers, Signal } from "/common.js";

const $ = (id) => document.getElementById(id);
const video = $("video");
const room = location.pathname.split("/")[2];
let pc, signal, iceServers;
const ice = getIceServers();

function setStatus(text) {
  $("status").textContent = text;
  $("status").classList.toggle("hidden", !text);
}

// The password is kept for this tab only, so a refresh doesn't ask again.
$("room-name").textContent = room;
try {
  const remembered = sessionStorage.getItem(`pw:${room}`);
  if (remembered) join(remembered);
} catch {}

$("gate").onsubmit = (e) => {
  e.preventDefault();
  join($("password").value);
};

async function join(password) {
  $("gate").classList.add("hidden");
  $("error").classList.add("hidden");
  setStatus("Connecting…");
  iceServers = await ice;
  signal = new Signal(`/ws/${room}`, {
    auth: { role: "viewer", password },
    onMessage: (msg) => {
      if (msg.type === "hello") {
        try {
          sessionStorage.setItem(`pw:${room}`, password);
        } catch {}
      }
      onMessage(msg);
    },
    onDrop: () => !isLive() && setStatus("Reconnecting…"),
    onEnd: (e) => {
      endStream();
      setStatus("");
      try {
        sessionStorage.removeItem(`pw:${room}`);
      } catch {}
      $("error").textContent = e.reason || "Disconnected from the room.";
      $("error").classList.remove("hidden");
      $("password").value = "";
      $("gate").classList.remove("hidden");
      $("password").focus();
    },
  });
}

function isLive() {
  return pc?.connectionState === "connected";
}

function onMessage(msg) {
  if (msg.type === "hello") {
    if (!isLive()) setStatus(msg.hostOnline ? "Connecting…" : "Waiting for the host to start sharing…");
  } else if (msg.type === "host-online") {
    if (!isLive()) setStatus("Connecting…");
  } else if (msg.type === "host-offline") {
    if (!isLive()) setStatus("Waiting for the host to start sharing…");
  } else if (msg.type === "signal") {
    onSignal(msg.data);
  }
}

async function onSignal(data) {
  if (data.bye) {
    endStream();
    setStatus("The host stopped sharing. This page will pick it back up if they start again.");
  } else if (data.sdp) {
    endStream();
    pc = new RTCPeerConnection({ iceServers });
    const mine = pc;
    pc.ontrack = (e) => {
      video.srcObject = e.streams[0];
      video.play().catch(() => {});
      $("unmute").classList.toggle("hidden", !(video.muted && e.streams[0].getAudioTracks().length));
    };
    pc.onicecandidate = (e) => e.candidate && signal.send({ type: "signal", data: { candidate: e.candidate } });
    pc.onconnectionstatechange = () => {
      if (pc !== mine) return;
      if (pc.connectionState === "connected") setStatus("");
      if (pc.connectionState === "failed") {
        setStatus("Couldn't connect to the host. Retrying…");
        signal.send({ type: "signal", data: { retry: true } });
      }
    };
    await pc.setRemoteDescription(data.sdp);
    await pc.setLocalDescription(await pc.createAnswer());
    signal.send({ type: "signal", data: { sdp: pc.localDescription } });
  } else if (data.candidate && pc) {
    pc.addIceCandidate(data.candidate).catch(() => {});
  }
}

function endStream() {
  pc?.close();
  pc = null;
  video.srcObject = null;
  $("unmute").classList.add("hidden");
}

$("unmute").onclick = () => {
  video.muted = false;
  video.play().catch(() => {});
  $("unmute").classList.add("hidden");
};

const toggleFullscreen = () =>
  document.fullscreenElement ? document.exitFullscreen() : $("stage").requestFullscreen().catch(() => {});
$("fullscreen").onclick = toggleFullscreen;
video.ondblclick = toggleFullscreen;

// Hide the cursor and buttons after a few seconds without mouse movement.
let idleTimer;
document.onmousemove = () => {
  $("stage").classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => $("stage").classList.add("idle"), 2500);
};
