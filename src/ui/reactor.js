// The animated arc reactor at the centre of the HUD.
// States: idle | thinking | listening | speaking | error
(function () {
  const canvas = document.getElementById('reactor');
  const ctx = canvas.getContext('2d');
  const BARS = 96;
  const bars = new Float32Array(BARS);
  let state = 'idle';
  let level = 0; // smoothed activity 0..1
  let external = 0; // driven level from mic / voice
  let flash = 0;
  let t0 = performance.now();
  let w = 0, h = 0, dpr = 1;

  const PALETTE = {
    idle: [95, 220, 255],
    thinking: [95, 220, 255],
    speaking: [120, 230, 255],
    listening: [255, 181, 71],
    error: [255, 79, 94],
  };
  let col = [...PALETTE.idle];

  // Resize inside the draw loop so a resize never leaves a blank frame.
  function syncSize() {
    const r = canvas.getBoundingClientRect();
    const d = window.devicePixelRatio || 1;
    if (r.width !== w || r.height !== h || d !== dpr) {
      w = r.width;
      h = r.height;
      dpr = d;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const rgba = (a) => `rgba(${col[0] | 0},${col[1] | 0},${col[2] | 0},${a})`;

  function ring(r, lw, a, dash, rot) {
    ctx.save();
    ctx.rotate(rot || 0);
    ctx.beginPath();
    ctx.setLineDash(dash || []);
    ctx.lineWidth = lw;
    ctx.strokeStyle = rgba(a);
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function arcs(r, lw, a, segs, rot, gapFrac) {
    ctx.save();
    ctx.rotate(rot);
    ctx.lineWidth = lw;
    ctx.strokeStyle = rgba(a);
    ctx.lineCap = 'butt';
    const step = (Math.PI * 2) / segs;
    for (let i = 0; i < segs; i++) {
      ctx.beginPath();
      ctx.arc(0, 0, r, i * step, i * step + step * (1 - gapFrac));
      ctx.stroke();
    }
    ctx.restore();
  }

  function ticks(r, n, len, a, rot, majorEvery) {
    ctx.save();
    ctx.rotate(rot);
    for (let i = 0; i < n; i++) {
      const major = majorEvery && i % majorEvery === 0;
      ctx.beginPath();
      ctx.lineWidth = major ? 1.6 : 1;
      ctx.strokeStyle = rgba(major ? a * 1.6 : a);
      const l = major ? len * 1.9 : len;
      ctx.moveTo(r, 0);
      ctx.lineTo(r - l, 0);
      ctx.stroke();
      ctx.rotate((Math.PI * 2) / n);
    }
    ctx.restore();
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden) return;
    syncSize();
    if (!w || !h) return;
    const t = (now - t0) / 1000;

    // target activity per state
    let target;
    if (state === 'thinking') target = 0.55 + 0.25 * Math.sin(t * 6);
    else if (state === 'listening' || state === 'speaking') target = Math.max(0.15, external);
    else if (state === 'error') target = 0.4;
    else target = 0.12 + 0.05 * Math.sin(t * 1.6);
    level += (target - level) * 0.12;
    flash *= 0.92;

    const want = PALETTE[state] || PALETTE.idle;
    for (let i = 0; i < 3; i++) col[i] += (want[i] - col[i]) * 0.08;

    const spin = state === 'thinking' ? 3.2 : state === 'idle' ? 0.6 : 1.4;
    const R = Math.min(w, h) * 0.46;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2 - (h > 260 ? 10 : 6));

    // soft halo
    const halo = ctx.createRadialGradient(0, 0, R * 0.1, 0, 0, R * 1.15);
    halo.addColorStop(0, rgba(0.18 + level * 0.25 + flash * 0.3));
    halo.addColorStop(0.45, rgba(0.05 + level * 0.06));
    halo.addColorStop(1, rgba(0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.15, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowColor = rgba(0.9);

    // outer frame
    ctx.shadowBlur = 0;
    ring(R, 1, 0.35);
    ticks(R - 3, 180, 4, 0.22, t * 0.05 * spin, 15);
    arcs(R + 7, 2, 0.6, 4, -t * 0.12 * spin, 0.72);
    ring(R * 0.92, 1, 0.18, [2, 6], t * 0.03);

    // heavy rotating segments
    ctx.shadowBlur = 12;
    arcs(R * 0.84, 5, 0.75, 3, t * 0.35 * spin, 0.38);
    ctx.shadowBlur = 0;
    arcs(R * 0.79, 1.5, 0.45, 12, -t * 0.22 * spin, 0.5);

    // audio / activity spectrum
    ctx.save();
    ctx.rotate(-Math.PI / 2);
    const inner = R * 0.55;
    const maxLen = R * 0.19;
    for (let i = 0; i < BARS; i++) {
      const n =
        0.5 + 0.5 * Math.sin(t * 5.3 + i * 0.47) * Math.sin(t * 2.1 + i * 0.13) +
        (state === 'speaking' || state === 'listening' ? (Math.random() - 0.5) * 0.6 : 0);
      const target2 = Math.max(0.04, Math.min(1, level * (0.35 + n * 0.85)));
      bars[i] += (target2 - bars[i]) * 0.25;
      const len = 3 + bars[i] * maxLen;
      const a = (i / BARS) * Math.PI * 2;
      ctx.beginPath();
      ctx.lineWidth = 2;
      ctx.strokeStyle = rgba(0.35 + bars[i] * 0.6);
      ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
      ctx.lineTo(Math.cos(a) * (inner + len), Math.sin(a) * (inner + len));
      ctx.stroke();
    }
    ctx.restore();

    // reactor coil segments
    ctx.save();
    ctx.rotate(-t * 0.18 * spin);
    const cr = R * 0.43;
    for (let i = 0; i < 10; i++) {
      ctx.beginPath();
      ctx.fillStyle = rgba(0.18 + level * 0.35);
      ctx.strokeStyle = rgba(0.7);
      ctx.lineWidth = 1;
      const a0 = (i / 10) * Math.PI * 2;
      const a1 = a0 + (Math.PI * 2) / 10 - 0.09;
      ctx.arc(0, 0, cr, a0, a1);
      ctx.arc(0, 0, cr * 0.82, a1, a0, true);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
    ring(R * 0.33, 1.2, 0.6, [3, 4], t * 0.5 * spin);

    // core
    const coreR = R * (0.2 + level * 0.035 + flash * 0.04);
    ctx.shadowBlur = 40 + level * 40;
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(0.35, rgba(0.95));
    core.addColorStop(0.75, rgba(0.35));
    core.addColorStop(1, rgba(0));
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(0, 0, coreR, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ring(coreR * 1.12, 1.5, 0.8);

    // crosshair marks
    ctx.strokeStyle = rgba(0.5);
    ctx.lineWidth = 1;
    for (let i = 0; i < 4; i++) {
      ctx.save();
      ctx.rotate((i * Math.PI) / 2);
      ctx.beginPath();
      ctx.moveTo(R + 14, 0);
      ctx.lineTo(R + 26, 0);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }
  requestAnimationFrame(frame);

  window.Reactor = {
    setState(s) {
      if (s !== state) flash = 1;
      state = s;
    },
    setLevel(v) {
      external = Math.max(0, Math.min(1, v));
    },
    pulse() {
      flash = 1;
      external = Math.min(1, external + 0.6);
    },
    get state() {
      return state;
    },
  };
})();
