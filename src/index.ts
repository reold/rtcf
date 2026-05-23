import { ChatRoom } from './lib/room';
export { ChatRoom };

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>🎵 Synced Audio Room</title>
<style>
  :root { color-scheme: dark; font-family: system-ui, sans-serif; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #111; color: #eee; display: flex; place-items: center; min-height: 100vh; }
  #app { width: min(100vw, 640px); margin: auto; display: flex; flex-direction: column; height: 90vh; background: #1a1a2e; border-radius: 8px; overflow: hidden; }
  header { background: #16213e; padding: .75rem 1rem; display: flex; justify-content: space-between; align-items: center; }
  header h1 { font-size: 1.1rem; }
  #users { color: #0f0; font-size: .85rem; }
  #player { padding: 1rem; background: #1a1a2e; display: flex; flex-direction: column; gap: .5rem; }
  #controls { display: flex; align-items: center; gap: .5rem; }
  button { padding: .5rem 1rem; border: none; border-radius: 4px; background: #0f0; color: #000; font-weight: bold; cursor: pointer; }
  button:disabled { background: #555; cursor: not-allowed; }
  input[type="range"] { flex: 1; }
  #time { font-size: .8rem; color: #aaa; }
  #messages { list-style: none; flex: 1; overflow-y: auto; padding: 1rem; border-top: 1px solid #333; }
  #messages li { margin-bottom: .4rem; word-break: break-word; }
  .time { font-size: .75rem; color: #888; margin-right: .4rem; }
  .system { color: #0f0; font-style: italic; }
  form { display: flex; padding: .5rem; background: #16213e; }
  input { flex: 1; padding: .5rem; border: none; border-radius: 4px; background: #222; color: #eee; }
  #sync-info { font-size: .8rem; color: #aaa; padding: .25rem .5rem; }

  /* Join overlay */
  #join-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.85); display: flex; align-items: center; justify-content: center; z-index: 100;
  }
  #join-box {
    background: #16213e; padding: 2rem; border-radius: 12px; display: flex; flex-direction: column; gap: 1rem; min-width: 280px;
  }
  #join-box h2 { margin: 0; }
  #join-box input { padding: .5rem; border-radius: 4px; border: none; background: #222; color: #eee; }
  #join-box button { align-self: flex-end; }
</style>
</head>
<body>
<div id="app">
  <header>
    <h1>🎵 Synced Audio Room</h1>
    <div>Online: <span id="users"></span></div>
  </header>
  <div id="player">
    <div id="controls">
      <button id="play-btn" disabled>▶️ Play</button>
      <button id="pause-btn" disabled>⏸️ Pause</button>
      <span id="current-time">0:00.000</span>
      <span>/</span>
      <span id="duration">0:00.000</span>
    </div>
    <input type="range" id="seek-bar" min="0" max="100" value="0" disabled />
    <div id="sync-info">Offset: -- ms | Syncing…</div>
  </div>
  <main>
    <ul id="messages"></ul>
    <form id="chat-form">
      <input type="text" id="msg-input" autocomplete="off" placeholder="Message..." disabled/>
      <button type="submit" id="send-btn" disabled>Send</button>
    </form>
  </main>
</div>

<!-- Join overlay -->
<div id="join-overlay">
  <div id="join-box">
    <h2>Join Room</h2>
    <input type="text" id="name-input" placeholder="Your nickname" maxlength="32" />
    <button id="join-btn">Join</button>
  </div>
</div>

<script>
  (() => {
    const messagesEl = document.getElementById('messages');
    const form = document.getElementById('chat-form');
    const input = document.getElementById('msg-input');
    const sendBtn = document.getElementById('send-btn');
    const usersEl = document.getElementById('users');
    const playBtn = document.getElementById('play-btn');
    const pauseBtn = document.getElementById('pause-btn');
    const seekBar = document.getElementById('seek-bar');
    const currentTimeSpan = document.getElementById('current-time');
    const durationSpan = document.getElementById('duration');
    const syncInfoEl = document.getElementById('sync-info');

    const roomId = location.pathname.split('/').filter(Boolean)[1] || 'lobby';
    const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/room/' + roomId;
    const ws = new WebSocket(wsUrl);
    let myName = '';

    const audioUrl = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3';
    const audio = new Audio(audioUrl);
    audio.preload = 'auto';
    let isUpdatingSlider = false;
    let audioReady = false;
    let pendingAction = null;

    let offset = 0, syncCount = 0, offsetSum = 0;
    const OFFSET_SAMPLES = 5;
    let playbackTimer = null;
    
    // Auth state reference used by our continuous timeline alignment sync
    let masterPlaybackState = null;

    function scheduleAction(action, position, serverTimestamp) {
      // Save full server action scope for periodic correction tracking loop
      masterPlaybackState = { action, position, serverTimestamp };

      const targetLocal = serverTimestamp - offset;
      const delay = targetLocal - Date.now();
      clearTimeout(playbackTimer);

      if (delay <= 0) {
        applyImmediately(action, position, Math.abs(delay));
      } else {
        playbackTimer = setTimeout(() => applyImmediately(action, position, 0), delay);
        syncInfoEl.textContent = \`Offset: \${offset.toFixed(1)} ms | Scheduled \${action} in \dots \${(delay/1000).toFixed(2)}s\`;
      }
    }

    function applyImmediately(action, position, lateByMs = 0) {
      if (!audioReady) { pendingAction = { action, position }; return; }
      
      if (action === 'play') {
        audio.currentTime = position + (lateByMs / 1000);
        audio.play().catch(()=>{});
        playBtn.disabled = true; pauseBtn.disabled = false;
      } else if (action === 'pause') {
        audio.pause();
        audio.playbackRate = 1.0; // Clear any pending drift pitch changes
        playBtn.disabled = false; pauseBtn.disabled = true;
      } else if (action === 'seek') {
        audio.currentTime = position + (lateByMs / 1000);
      }
    }

    function startDriftCorrectionLoop() {
      setInterval(() => {
        if (!audioReady || !masterPlaybackState || audio.paused) {
          audio.playbackRate = 1.0;
          return;
        }

        if (masterPlaybackState.action === 'play') {
          const serverNow = Date.now() + offset;
          const timePassedSinceServerEvent = (serverNow - masterPlaybackState.serverTimestamp) / 1000;
          const expectedPosition = masterPlaybackState.position + timePassedSinceServerEvent;
          
          const drift = expectedPosition - audio.currentTime;

          // Catch large drifts (greater than 1.0s) via an explicit seek jump
          if (Math.abs(drift) > 1.0) {
            audio.currentTime = expectedPosition;
            audio.playbackRate = 1.0;
            syncInfoEl.textContent = \`Drift large (\${(drift*1000).toFixed(0)}ms)! Hard-syncing...\`;
          } 
          // Micro-adjustments (greater than 30ms bounds) utilizing structural playback rate warping
          else if (drift > 0.030) {
            audio.playbackRate = 1.02; // Speed up up to 2%
            syncInfoEl.textContent = \`Lagging by \${(drift*1000).toFixed(0)}ms | Micro-speeding up...\`;
          } else if (drift < -0.030) {
            audio.playbackRate = 0.98; // Slow down down to 2%
            syncInfoEl.textContent = \`Leading by \${Math.abs(drift*1000).toFixed(0)}ms | Micro-slowing down...\`;
          } else {
            audio.playbackRate = 1.0; 
            syncInfoEl.textContent = \`Offset: \${offset.toFixed(1)} ms | Perfectly in Sync (Drift less than 30ms)\`;
          }
        }
      }, 2000);
    }

    // Initialize correction timeline alignment checks
    startDriftCorrectionLoop();

    function sendPlaybackAction(action, position) {
      const pos = (typeof position === 'number') ? position : audio.currentTime;
      ws.send(JSON.stringify({ type: 'playback', action, position: pos }));
    }

    playBtn.addEventListener('click', () => sendPlaybackAction('play'));
    pauseBtn.addEventListener('click', () => sendPlaybackAction('pause'));
    seekBar.addEventListener('input', () => {
      if (!isUpdatingSlider) {
        const pos = (seekBar.value / 100) * audio.duration;
        audio.currentTime = pos;
        currentTimeSpan.textContent = formatTime(pos);
      }
    });
    seekBar.addEventListener('change', () => {
      const pos = (seekBar.value / 100) * audio.duration;
      sendPlaybackAction('seek', pos);
    });

    audio.addEventListener('timeupdate', () => {
      if (!isUpdatingSlider) {
        seekBar.value = (audio.currentTime / audio.duration) * 100 || 0;
        currentTimeSpan.textContent = formatTime(audio.currentTime);
      }
    });
    audio.addEventListener('loadedmetadata', () => {
      durationSpan.textContent = formatTime(audio.duration);
      seekBar.disabled = false;
    });
    audio.addEventListener('canplay', () => {
      audioReady = true;
      playBtn.disabled = false; pauseBtn.disabled = false;
      if (pendingAction) { applyImmediately(pendingAction.action, pendingAction.position); pendingAction = null; }
    });

    function formatTime(sec) {
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60).toString().padStart(2, '0');
      const ms = Math.floor((sec % 1) * 1000).toString().padStart(3, '0');
      return \`\${m}:\${s}.\${ms}\`;
    }

    // ----- Join form handling -----
    const joinOverlay = document.getElementById('join-overlay');
    const nameInput = document.getElementById('name-input');
    const joinBtn = document.getElementById('join-btn');

    joinBtn.addEventListener('click', () => {
      const name = nameInput.value.trim();
      if (!name) return;
      myName = name;
      joinOverlay.style.display = 'none';
      input.disabled = false; sendBtn.disabled = false;
      ws.send(JSON.stringify({ type: 'join', name: myName, clientId: crypto.randomUUID() }));
      // Start time sync
      for (let i = 0; i < OFFSET_SAMPLES; i++) {
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'sync_request', clientTs: performance.now() }));
          }
        }, i * 200);
      }
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinBtn.click();
    });

    // ----- WebSocket message handling -----
    ws.addEventListener('message', (e) => {
      const data = JSON.parse(e.data);
      const li = document.createElement('li');

      switch (data.type) {
        case 'message':
          li.innerHTML = '<span class="time">' + new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</span>' +
            '<strong>' + escapeHtml(data.user) + '</strong>: ' + escapeHtml(data.text);
          break;
        case 'join':
          li.className = 'system'; li.textContent = data.user + ' joined'; break;
        case 'leave':
          li.className = 'system'; li.textContent = data.user + ' left'; break;
        case 'users':
          usersEl.textContent = data.users?.join(', ') || 'none'; return;
        case 'sync_reply': {
          const roundTrip = performance.now() - data.clientTs;
          const estimatedServerNow = data.serverTs + roundTrip / 2;
          const newOffset = estimatedServerNow - Date.now();
          offsetSum += newOffset; syncCount++; offset = offsetSum / syncCount;
          syncInfoEl.textContent = \`Offset: \${offset.toFixed(1)} ms | Synced \${syncCount} samples\`;
          return;
        }
        case 'playback':
          scheduleAction(data.action, data.position, data.timestamp);
          return;
        default:
          li.textContent = JSON.stringify(data);
      }
      messagesEl.appendChild(li);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      ws.send(JSON.stringify({ type: 'message', text }));
      input.value = '';
    });

    function escapeHtml(str) {
      const div = document.createElement('div');
      div.appendChild(document.createTextNode(str));
      return div.innerHTML;
    }
  })();
</script>
</body>
</html>`;

export default {
	async fetch(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/' || !url.pathname.startsWith('/room/')) {
			return new Response(HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
		}
		const roomId = url.pathname.split('/')[2] || 'lobby';
		const id = env.CHAT_ROOM.idFromName(roomId);
		const stub = env.CHAT_ROOM.get(id);
		const newUrl = new URL('/websocket', request.url);
		const newReq = new Request(newUrl, request);
		return stub.fetch(newReq);
	},
};
