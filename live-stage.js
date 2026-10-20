// Live page video stage: creator camera (getUserMedia), staged preview feed
// for viewers, and the broadcast-style overlays shared by both.
(function () {
  // ---------- Staged feed (viewers) ----------
  // A seeded canvas animation: soft drifting light blobs over a gradient,
  // chosen consistently per creator id. No external assets, no licensing.
  function hashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {
    let a = seed || 1;
    return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  function startStagedFeed(canvas, creatorId) {
    const ctx = canvas.getContext('2d');
    const rand = rng(hashSeed(String(creatorId)));
    const baseHue = Math.floor(rand() * 360);
    const scene = {
      hueA: baseHue, hueB: (baseHue + 40 + rand() * 80) % 360,
      blobs: Array.from({ length: 7 }, () => ({
        x: rand(), y: rand(), r: 0.12 + rand() * 0.22, sx: 0.02 + rand() * 0.05, sy: 0.02 + rand() * 0.05,
        px: rand() * 6.28, py: rand() * 6.28, hue: (baseHue + rand() * 120 - 60 + 360) % 360
      })),
      // A soft silhouette so it reads as "someone on camera"
      figureX: 0.42 + rand() * 0.16
    };
    let raf = 0, running = true;
    function resize() {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(320, Math.round(r.width * dpr));
      canvas.height = Math.max(180, Math.round(r.height * dpr));
    }
    function frame(ts) {
      if (!running) return;
      const t = ts / 1000, w = canvas.width, h = canvas.height;
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, `hsl(${scene.hueA}, 45%, 14%)`);
      g.addColorStop(1, `hsl(${scene.hueB}, 50%, 22%)`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      for (const b of scene.blobs) {
        const x = (b.x + Math.sin(t * b.sx * 6 + b.px) * 0.08) * w;
        const y = (b.y + Math.cos(t * b.sy * 6 + b.py) * 0.08) * h;
        const r = b.r * Math.max(w, h) * (1 + Math.sin(t * 0.6 + b.px) * 0.06);
        const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
        rg.addColorStop(0, `hsla(${b.hue}, 80%, 60%, 0.22)`);
        rg.addColorStop(1, `hsla(${b.hue}, 80%, 60%, 0)`);
        ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      // silhouette with gentle "breathing" motion
      const fx = scene.figureX * w + Math.sin(t * 0.5) * w * 0.006, sway = Math.sin(t * 0.8) * h * 0.004;
      ctx.fillStyle = 'rgba(5, 6, 10, 0.55)';
      ctx.beginPath(); ctx.ellipse(fx, h * 0.42 + sway, h * 0.11, h * 0.14, 0, 0, 6.283); ctx.fill();
      ctx.beginPath(); ctx.ellipse(fx, h * 1.02 + sway, h * 0.34, h * 0.42, 0, Math.PI, 0); ctx.fill();
      // vignette
      const v = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.55)');
      ctx.fillStyle = v; ctx.fillRect(0, 0, w, h);
      raf = requestAnimationFrame(frame);
    }
    resize();
    window.addEventListener('resize', resize);
    raf = requestAnimationFrame(frame);
    return { stop() { running = false; cancelAnimationFrame(raf); window.removeEventListener('resize', resize); }, hue: scene.hueA };
  }

  // ---------- Creator camera ----------
  const CAM_ERRORS = {
    insecure: { title: 'Camera needs a secure connection', text: 'Open this page over HTTPS (or on localhost) to use your camera.' },
    unsupported: { title: "This browser can't use the camera", text: 'Try a recent version of Chrome, Safari, Firefox or Edge.' },
    denied: { title: 'Camera access was blocked', text: 'Allow camera and microphone for this site in your browser’s address bar or settings, then try again.' },
    notfound: { title: 'No camera found', text: 'Connect a camera (and microphone) and try again.' },
    inuse: { title: 'Your camera is busy', text: 'Another app or tab is using the camera. Close it and try again.' },
    other: { title: "Couldn't start the camera", text: 'Something went wrong starting your camera. Please try again.' }
  };
  function classifyError(err) {
    const n = err && err.name;
    if (n === 'NotAllowedError' || n === 'PermissionDeniedError' || n === 'SecurityError') return 'denied';
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError') return 'notfound';
    if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return 'inuse';
    if (n === 'NotSupportedError' || n === 'TypeError') return 'unsupported';
    return 'other';
  }
  function cameraSupportProblem() {
    if (!window.isSecureContext) return 'insecure';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return 'unsupported';
    return null;
  }

  class CreatorCam {
    constructor(video) { this.video = video; this.stream = null; this.camId = ''; this.micId = ''; }
    get active() { return !!this.stream; }
    async start({ camId = this.camId, micId = this.micId } = {}) {
      const video = camId ? { deviceId: { exact: camId } } : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } };
      const audio = micId ? { deviceId: { exact: micId } } : true;
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video, audio });
      } catch (err) {
        // Some setups have a camera but no mic: fall back to video only
        if (err && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') && !micId) {
          stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        } else throw err;
      }
      const prev = this.stream;
      const wasMuted = prev && this.muted, wasCamOff = prev && this.cameraOff;
      this.stopTracks(prev);
      this.stream = stream;
      const vt = stream.getVideoTracks()[0], at = stream.getAudioTracks()[0];
      this.camId = (vt && vt.getSettings().deviceId) || camId || '';
      this.micId = (at && at.getSettings().deviceId) || micId || '';
      if (wasMuted && at) at.enabled = false;
      if (wasCamOff && vt) vt.enabled = false;
      this.video.srcObject = stream;
      this.video.muted = true; // never play your own mic back
      await this.video.play().catch(() => {});
      return stream;
    }
    async devices() {
      const list = await navigator.mediaDevices.enumerateDevices();
      return { cams: list.filter(d => d.kind === 'videoinput'), mics: list.filter(d => d.kind === 'audioinput') };
    }
    get muted() { const t = this.stream && this.stream.getAudioTracks()[0]; return !t || !t.enabled; }
    get hasMic() { return !!(this.stream && this.stream.getAudioTracks()[0]); }
    get cameraOff() { const t = this.stream && this.stream.getVideoTracks()[0]; return !t || !t.enabled; }
    setMuted(m) { (this.stream ? this.stream.getAudioTracks() : []).forEach(t => { t.enabled = !m; }); }
    setCameraOff(off) { (this.stream ? this.stream.getVideoTracks() : []).forEach(t => { t.enabled = !off; }); }
    stopTracks(stream) { if (stream) stream.getTracks().forEach(t => t.stop()); }
    stop() { this.stopTracks(this.stream); this.stream = null; this.video.srcObject = null; }
  }

  function formatElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  }

  window.LiveStage = { startStagedFeed, CreatorCam, CAM_ERRORS, classifyError, cameraSupportProblem, formatElapsed };
})();
