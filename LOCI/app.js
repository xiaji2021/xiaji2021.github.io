/* LOCI page draft. Everything media-related comes from manifest.json (built from tools/picks.json). */
(() => {
'use strict';
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = s => document.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const angd = (a, b) => { const d = ((a - b) % 360 + 540) % 360 - 180; return Math.abs(d); };
const fmtYaw = y => { const w = ((y % 360) + 540) % 360 - 180; return (w > 0 ? '+' : w < 0 ? '−' : '') + Math.abs(Math.round(w)) + '°'; };

/* ---------- trajectories ---------- */
const trajCache = {};
function loadTraj(url) {
  if (!trajCache[url]) trajCache[url] = fetch(url).then(r => r.json()).then(prep);
  return trajCache[url];
}
function prep(t) {
  const n = t.yaw.length, dt = t.dt, BINS = 72;
  // first latent at which each 5-degree heading bin entered the 90-degree field of view
  const first = new Array(BINS).fill(Infinity);
  const cum = new Float32Array(n);
  const dist = new Float32Array(n); // metres walked
  const rev = new Float32Array(n); // >0: seconds since this pose was first seen (revisit)
  for (let i = 0; i < n; i++) {
    for (let b = 0; b < BINS; b++) if (first[b] === Infinity && angd(b * 5 + 2.5, t.yaw[i]) <= 45) first[b] = i;
    if (i) { cum[i] = cum[i - 1] + Math.abs(t.yaw[i] - t.yaw[i - 1]); dist[i] = dist[i - 1] + Math.hypot(t.x[i] - t.x[i - 1], t.z[i] - t.z[i - 1]); }
    for (let j = 0; j <= i - 16; j++) {
      if (angd(t.yaw[i], t.yaw[j]) < 12 && Math.hypot(t.x[i] - t.x[j], t.z[i] - t.z[j]) < 0.6) { rev[i] = (i - j) * dt; break; }
    }
  }
  return Object.assign(t, { n, first, cum, dist, rev, BINS });
}
const idxAt = (t, ts) => clamp(Math.floor(ts / t.dt), 0, t.n - 1);
function yawAt(t, ts) {
  const f = clamp(ts / t.dt, 0, t.n - 1), i = Math.floor(f), j = Math.min(i + 1, t.n - 1), u = f - i;
  return t.yaw[i] * (1 - u) + t.yaw[j] * u;
}

/* ---------- yaw ring (compass) ---------- */
let ringN = 0;
function makeRing(svg, t) {
  const id = 'coneg' + (ringN++);
  const defs = el('defs', {}, svg);
  const g = el('radialGradient', { id, cx: 0, cy: 0, r: 46, gradientUnits: 'userSpaceOnUse' }, defs);
  el('stop', { offset: '0', 'stop-color': '#fff', 'stop-opacity': '.85' }, g);
  el('stop', { offset: '1', 'stop-color': '#fff', 'stop-opacity': '0' }, g);
  el('circle', { class: 'r-base', r: 46 }, svg);
  const pulse = el('circle', { class: 'r-pulse', r: 46 }, svg);
  for (let a = 0; a < 360; a += 30) {
    const s = Math.sin(a * Math.PI / 180), c = -Math.cos(a * Math.PI / 180), r0 = a % 90 ? 42 : 39;
    el('line', { class: 'r-tick', x1: s * r0, y1: c * r0, x2: s * 46, y2: c * 46 }, svg);
  }
  const lab = el('text', { class: 'r-n', x: 0, y: -50 }, svg); lab.textContent = 'START';
  // coverage arcs (what has been seen so far)
  const arcs = [];
  for (let b = 0; b < 72; b++) {
    const a0 = (b * 5) * Math.PI / 180, a1 = (b * 5 + 5.4) * Math.PI / 180, R = 50;
    arcs.push(el('path', { class: 'r-seen', d: `M${R * Math.sin(a0)} ${-R * Math.cos(a0)}A${R} ${R} 0 0 1 ${R * Math.sin(a1)} ${-R * Math.cos(a1)}`, opacity: 0 }, svg));
  }
  const marks = el('g', {}, svg);
  const cone = el('path', { class: 'r-cone', d: wedge(0, 90, 44), fill: `url(#${id})` }, svg);
  el('circle', { class: 'r-dot', r: 2.6 }, svg);
  let lastSeen = -1;
  return {
    update(ts, revisitOn) {
      const yaw = yawAt(t, ts), i = idxAt(t, ts);
      cone.setAttribute('transform', `rotate(${yaw})`);
      if (i !== lastSeen) { for (let b = 0; b < 72; b++) arcs[b].setAttribute('opacity', t.first[b] <= i ? 0.9 : 0); lastSeen = i; }
      svg.classList.toggle('revisit', !!revisitOn);
      return { yaw, i };
    },
    setMarks(list) { // [{yaw, color}]
      marks.textContent = '';
      for (const m of list) {
        const a = m.yaw * Math.PI / 180, s = Math.sin(a), c = -Math.cos(a);
        el('line', { x1: s * 54, y1: c * 54, x2: s * 60, y2: c * 60, stroke: m.color, 'stroke-width': m.w || 1.6, 'stroke-linecap': 'round', opacity: m.o || 1 }, marks);
      }
    }
  };
}
function wedge(center, fov, R) {
  const a0 = (center - fov / 2) * Math.PI / 180, a1 = (center + fov / 2) * Math.PI / 180;
  return `M0 0L${R * Math.sin(a0)} ${-R * Math.cos(a0)}A${R} ${R} 0 0 1 ${R * Math.sin(a1)} ${-R * Math.cos(a1)}Z`;
}

/* ---------- visibility-driven rAF loops ---------- */
function loopWhileVisible(target, fn) {
  let on = false, raf = 0;
  const tick = () => { fn(); if (on) raf = requestAnimationFrame(tick); };
  new IntersectionObserver(es => es.forEach(e => {
    on = e.isIntersecting; cancelAnimationFrame(raf); if (on) raf = requestAnimationFrame(tick);
  }), { rootMargin: '100px' }).observe(target);
}
function playWhenVisible(video, sec, opts = {}) {
  new IntersectionObserver(es => es.forEach(e => {
    if (e.isIntersecting) { if (!video.src) { video.preload = 'auto'; video.src = opts.src; } if (!RM || opts.force) video.play().catch(() => {}); }
    else video.pause();
  }), { threshold: 0.25 }).observe(sec);
}

function lazyPoster(v, url, sec) {
  const ob = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { if (!v.poster) v.poster = url; ob.disconnect(); } }), { rootMargin: '100% 0px' });
  ob.observe(sec);
}
/* ---------- generic page chrome ---------- */
const bar = $('#bar');
const heroSec = $('#top');
const barUpd = () => bar.classList.toggle('solid', scrollY > heroSec.offsetHeight - 48);
addEventListener('scroll', barUpd, { passive: true }); addEventListener('resize', barUpd); barUpd();
const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
document.querySelectorAll('.reveal').forEach(n => io.observe(n));

// statement: words light up as it scrolls through the viewport
document.querySelectorAll('.reveal-words').forEach(p => {
  const wrap = node => {
    [...node.childNodes].forEach(ch => {
      if (ch.nodeType === 3) {
        const frag = document.createDocumentFragment();
        ch.textContent.split(/(\s+)/).forEach(w => {
          if (!w) return;
          if (/^\s+$/.test(w)) frag.appendChild(document.createTextNode(w));
          else { const s = document.createElement('span'); s.className = 'w'; s.textContent = w; frag.appendChild(s); }
        });
        ch.replaceWith(frag);
      } else wrap(ch);
    });
  };
  wrap(p);
  const ws = [...p.querySelectorAll('.w')];
  const upd = () => {
    const r = p.getBoundingClientRect(), v = innerHeight;
    const prog = clamp((v * 0.85 - r.top) / (r.height + v * 0.35), 0, 1);
    const k = Math.round(prog * ws.length * 1.15);
    ws.forEach((w, i) => w.classList.toggle('on', i < k));
  };
  addEventListener('scroll', upd, { passive: true }); upd();
});

$('#copy-citation').addEventListener('click', async () => {
  const st = $('#copy-status');
  try { await navigator.clipboard.writeText($('#bibtex').textContent); st.textContent = 'Citation copied.'; }
  catch { st.textContent = 'Select the citation above to copy it.'; }
});

/* ---------- hero (v2): screen 1 = paper credits over the video; first scroll fades them out and the slogan in ----------
   Same pinned frame and curves as the approved 10a7e1b transition, with the two screens swapped (user 10-03). */
(function heroScroll() {
  const pin = $('.hero-pin'), copy = $('.hero-copy'), cred = $('#credits'), shade2 = $('.hero-shade2'), meta = $('#hero-meta'), cue = $('.scroll-cue'), ringEl = $('.hero-ring');
  const lines = [...copy.querySelectorAll('.hero-title span, .hero-sub')];
  const c01 = x => Math.min(1, Math.max(0, x));
  const onScroll = () => {
    if (RM) return;
    const p = c01(window.scrollY / pin.clientHeight);
    const out = c01((p - 0.04) / 0.32), inn = c01((p - 0.3) / 0.4);
    cred.style.opacity = cue.style.opacity = String(1 - out);
    cred.style.transform = `translateY(${(-36 * out).toFixed(1)}px)`;
    cred.style.pointerEvents = out < 0.5 ? 'auto' : 'none';
    shade2.style.opacity = String(1 - inn);
    copy.style.opacity = ringEl.style.opacity = meta.style.opacity = String(inn);
    copy.style.transform = `translateY(${(24 * (1 - inn)).toFixed(1)}px)`;
    lines.forEach((l, i) => { const k = c01((inn - i * 0.12) / 0.55); l.style.opacity = String(k); l.style.transform = `translateY(${(0.35 * (1 - k)).toFixed(3)}em)`; });
  };
  addEventListener('scroll', onScroll, { passive: true }); addEventListener('resize', onScroll); onScroll();
  // the credits are the first screen now: links to #credits go back to the top
  document.querySelectorAll('a[href="#credits"]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); scrollTo({ top: 0, behavior: RM ? 'auto' : 'smooth' }); }));
  // reduced motion: nothing is pinned; credits stay over the video, the slogan stacks below it
  if (RM) pin.after(copy);
})();

/* ---------- main ---------- */
fetch('manifest.json', {cache: 'no-cache'}).then(r => r.json()).then(M => {
  hero(M.hero); turn(M.scrub); thenNow(M.thennow); memory(M.memory); live(M.realtime, M.stats); wall(M.wall, M.trajectory_names);
}).catch(err => console.error('manifest', err));

/* HERO */
async function hero(H) {
  const v = $('#hero-video'), sec = $('#top');
  v.poster = H.poster;
  v.src = H.src;
  if (RM) { v.removeAttribute('autoplay'); v.pause(); } else v.play().catch(() => {});
  $('#hero-meta').textContent = `Generated by LOCI (4-step distilled, 5B) · ${H.title}`;
  const t = await loadTraj(H.traj);
  const ring = makeRing($('#hero-ring'), t), wrapEl = $('.hero-ring'), yawEl = $('#hero-yaw'), stEl = $('#hero-state');
  let lastState = '';
  loopWhileVisible(sec, () => {
    const ts = v.currentTime * H.speed, i = idxAt(t, ts), r = t.rev[i];
    const { yaw } = ring.update(ts, r > 0);
    yawEl.textContent = fmtYaw(yaw);
    let s = ts < 1.2 ? 'first look' : r > 0 ? `revisit · seen ${Math.round(r)} s ago` : 'looking around';
    wrapEl.classList.toggle('revisit', r > 0);
    if (s !== lastState) { stEl.textContent = s; lastState = s; }
  });
  new IntersectionObserver(es => es.forEach(e => { if (RM) return; e.isIntersecting ? v.play().catch(() => {}) : v.pause(); })).observe(sec);
}

/* SCROLL-SCRUBBED TURN */
async function turn(S) {
  const v = $('#turn-video'), sec = $('#turn'), cap = $('#turn-cap'), deg = $('#turn-deg'), distEl = $('#turn-dist'), barI = $('#turn-bar');
  const C = S.captions || { start: 'Start here.', mid: 'Turn all the way around.', end: 'Back again. Just as you left it.' };
  lazyPoster(v, S.poster, sec);
  $('#turn-meta').textContent = `Generated by LOCI (4-step distilled, 5B) · ${S.title}`;
  const t = await loadTraj(S.traj);
  const ring = makeRing($('#turn-ring'), t);
  const lens = S.segments.map(([a, b]) => b - a);
  const total = lens.reduce((a, b) => a + b, 0);
  const toSrc = tv => { let acc = 0; for (let k = 0; k < S.segments.length; k++) { if (tv < acc + lens[k] || k === S.segments.length - 1) return [S.segments[k][0] + (tv - acc), k]; acc += lens[k]; } };
  const load = () => { if (!v.src) { v.preload = 'auto'; v.src = S.src; v.load(); } };
  new IntersectionObserver(es => es.forEach(e => e.isIntersecting && load()), { rootMargin: '200% 0px' }).observe(sec);
  // prefetch the scrub clip shortly after the page has loaded, so scrolling into the section does not stall
  if (document.readyState === 'complete') setTimeout(load, 1500); else window.addEventListener('load', () => setTimeout(load, 1500));
  let lastCap = '';
  const setCap = s => {
    if (s === lastCap) return; lastCap = s;
    if (RM) { cap.textContent = s; return; }
    cap.classList.add('fade'); setTimeout(() => { cap.textContent = s; cap.classList.remove('fade'); }, 180);
  };
  const render = tv => {
    const [ts, k] = toSrc(tv), i = idxAt(t, ts), r = t.rev[i];
    ring.update(ts, r > 0);
    deg.textContent = Math.round(t.cum[i]);
    if (distEl) distEl.textContent = t.dist[i].toFixed(1);
    barI.style.width = (tv / total * 100).toFixed(2) + '%';
    let s;
    if (S.motion === 'orbit') s = ts < 1.4 ? C.start : (r > 0 && tv > total - 3) || tv > total - 1 ? C.end : C.mid;
    else if (k === 0) s = ts < 1.4 ? C.start : t.cum[i] < 350 ? C.mid : 'Full circle. Nothing moved.';
    else s = r > 0 && tv > total - 4 ? C.end : 'Step away. Look elsewhere.';
    setCap(s);
  };
  if (RM) { // no scroll-jacking: a normal player, overlay still synced
    v.controls = true; v.loop = true;
    loopWhileVisible(sec, () => render(v.currentTime * (S.speed || 1)));
    return;
  }
  // Scroll -> clip time so that equal scroll = equal apparent camera motion (the clip's turn rate is uneven),
  // then approach that time with a time-based ease and a capped rate, so mouse-wheel notches don't jump.
  const grid = [], mo = [];
  for (let tv = 0; tv <= total - 0.05; tv += 1 / 16) {
    const [ts] = toSrc(tv), i = idxAt(t, ts);
    grid.push(tv); mo.push(t.cum[i] / 40 + t.dist[i]);   // 40 degrees of turning ~ 1 m of walking
  }
  for (let i = 1; i < mo.length; i++) if (mo[i] < mo[i - 1]) mo[i] = mo[i - 1];
  const moT = mo[mo.length - 1] || 1;
  const timeAt = p => { const m = p * moT; let lo = 0, hi = mo.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (mo[mid] < m) lo = mid + 1; else hi = mid; } return grid[lo]; };
  let target = 0, shown = -1, last = performance.now();
  loopWhileVisible(sec, () => {
    const r = sec.getBoundingClientRect();
    const p = clamp(-r.top / (r.height - innerHeight), 0, 1);
    const now = performance.now(), dtR = Math.min(0.05, (now - last) / 1000); last = now;
    const goal = timeAt(p), k = 1 - Math.exp(-dtR / 0.07), maxStep = 12 * dtR;   // tight coupling: ~70 ms ease, cap only guards against seek storms
    target += Math.max(-maxStep, Math.min(maxStep, (goal - target) * k));
    if (Math.abs(target - shown) > 1 / 60) {
      if (v.readyState >= 1 && !v.seeking) { v.currentTime = target / (S.speed || 1); }   // clip is encoded at S.speed x; target is in source seconds
      render(target); shown = target;
    }
  });
}

/* THEN / NOW */
function thenNow(list) {
  const stage = $('#tn-stage'), clip = $('#tn-clip'), handle = $('#tn-handle'), strip = $('#tn-strip');
  const imT = $('#tn-then'), imN = $('#tn-now');
  let pos = 50, cur = 0, anim = 0;
  const set = p => { pos = clamp(p, 0, 100); clip.style.clipPath = `inset(0 0 0 ${pos}%)`; handle.style.left = pos + '%'; handle.setAttribute('aria-valuenow', Math.round(pos)); };
  const sel = (i, pre = true) => {
    cur = i; const it = list[i];
    imT.src = it.then; imN.src = it.now;
    imT.alt = `${it.title}: first view at ${it.then_t} s`; imN.alt = `${it.title}: same pose revisited at ${it.now_t} s`;
    $('#tn-tag-then').textContent = `First seen · ${it.then_t.toFixed(1)} s`;
    $('#tn-tag-now').textContent = `Revisited · ${it.now_t.toFixed(1)} s`;
    [...strip.children].forEach((b, k) => b.setAttribute('aria-current', k === i));
    // preload the next pair
    const nx = list[(i + 1) % list.length]; if (pre) [nx.then, nx.now].forEach(s => { const im = new Image(); im.src = s; });
  };
  list.forEach((it, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'listitem');
    b.innerHTML = `<img loading="lazy" alt="" src="${it.then}"><span></span>`; b.querySelector('span').textContent = it.title;
    b.setAttribute('aria-label', it.title);
    b.onclick = () => { sel(i); if (!RM) sweep(); };
    strip.appendChild(b);
  });
  sel(0, false); set(50);
  const fromEvt = e => { const r = stage.getBoundingClientRect(); set((e.clientX - r.left) / r.width * 100); };
  let drag = false;
  stage.addEventListener('pointerdown', e => { drag = true; cancelAnimationFrame(anim); stage.setPointerCapture(e.pointerId); fromEvt(e); });
  stage.addEventListener('pointermove', e => drag && fromEvt(e));
  stage.addEventListener('pointerup', () => drag = false);
  stage.addEventListener('pointercancel', () => drag = false);
  handle.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') { set(pos - 5); e.preventDefault(); }
    if (e.key === 'ArrowRight') { set(pos + 5); e.preventDefault(); }
  });
  function sweep() { // reveal: slide from "all then" to the middle
    cancelAnimationFrame(anim); const t0 = performance.now(), D = 1600;
    const f = now => { const u = clamp((now - t0) / D, 0, 1), e = 1 - Math.pow(1 - u, 3); set(96 - 46 * e); if (u < 1) anim = requestAnimationFrame(f); };
    anim = requestAnimationFrame(f);
  }
  if (!RM) {
    const ob = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { sweep(); ob.disconnect(); } }), { threshold: 0.6 });
    ob.observe(stage);
  }
}

/* MEMORY */
async function memory(Mm) {
  const v = $('#mem-video'), sec = $('#memory');
  lazyPoster(v, Mm.poster, sec);
  playWhenVisible(v, sec, { src: Mm.src });
  if (RM) v.controls = true;
  const t = await loadTraj(Mm.traj);
  const ring = makeRing($('#mem-ring'), t);
  const N = t.n, CH = 5, RECENT = 8, BANK = 20;
  const PINS = new Set([1, 9, 17, 25, 33, 41, 49, 57, 65, 73]);
  // simulate the bounded memory, one snapshot per committed chunk
  const snaps = []; // snaps[c] = state while generating chunk c (1-based); committed latents 1..5(c-1)
  let bank = [], recent = [];
  const nChunks = Math.ceil((N - 1) / CH);
  for (let c = 1; c <= nChunks; c++) {
    snaps[c] = { bank: bank.slice(), recent: recent.slice(), committed: (c - 1) * CH };
    for (let l = (c - 1) * CH + 1; l <= Math.min(c * CH, N - 1); l++) {
      recent.push(l);
      if (recent.length > RECENT) {
        const out = recent.shift(); bank.push(out);
        if (bank.length > BANK) { // drop the most redundant non-pinned view (closest heading/position to another kept view)
          let worst = -1, wd = Infinity;
          bank.forEach((b, k) => {
            if (PINS.has(b)) return;
            let d = angd(t.yaw[b], t.yaw[0]) + 40 * Math.hypot(t.x[b] - t.x[0], t.z[b] - t.z[0]);
            bank.forEach(o => { if (o !== b) d = Math.min(d, angd(t.yaw[b], t.yaw[o]) + 40 * Math.hypot(t.x[b] - t.x[o], t.z[b] - t.z[o])); });
            if (d < wd || (d === wd && b > bank[worst])) { wd = d; worst = k; } // ties: keep the earlier view
          });
          bank.splice(worst, 1);
        }
      }
    }
  }
  // timeline svg
  const svg = $('#mem-tl'); svg.setAttribute('viewBox', `0 0 ${N} 10`);
  const cells = [];
  for (let l = 0; l < N; l++) cells.push(el('rect', { x: l + 0.12, y: 0, width: 0.76, height: 10, rx: 0.2, fill: '#e8e8ed' }, svg));
  const head = el('rect', { x: 0, y: -1, width: 0.25, height: 12, fill: '#1d1d1f' }, svg);
  $('#mem-total').textContent = ((N - 1) * t.dt).toFixed(0) + ' s';
  const C = { sink: '#ffffff', sinkCell: '#1d1d1f', anchor: '#e08a2c', bank: 'rgba(226,140,44,.45)', recent: '#3d9bd6', cur: 'rgba(0,0,0,.28)', gone: '#efe4d6', fut: '#e8e8ed' };
  const nA = $('#n-anchor'), nB = $('#n-bank'), nR = $('#n-recent'), nS = $('#n-state'), band = $('.kda-band');
  let lastC = -1;
  loopWhileVisible(sec, () => {
    const ts = v.currentTime * Mm.speed, L = idxAt(t, ts), c = clamp(Math.ceil(Math.max(L, 1) / CH), 1, nChunks), s = snaps[c];
    ring.update(ts, t.rev[L] > 0);
    head.setAttribute('x', clamp(L, 0, N - 1));
    if (c === lastC) return;
    if (lastC !== -1 && c > lastC && !RM) { band.classList.add('beat'); setTimeout(() => band.classList.remove('beat'), 140); }
    lastC = c;
    const bset = new Set(s.bank), rset = new Set(s.recent);
    const marks = [{ yaw: t.yaw[0], color: C.sink, w: 2.4 }];
    let na = 0, nb = 0;
    for (let l = 0; l < N; l++) {
      let f;
      if (l === 0) f = C.sinkCell;
      else if (l > s.committed) f = l <= s.committed + CH ? C.cur : C.fut;
      else if (rset.has(l)) { f = C.recent; marks.push({ yaw: t.yaw[l], color: C.recent, o: .9 }); }
      else if (bset.has(l)) { const a = PINS.has(l); a ? na++ : nb++; f = a ? C.anchor : C.bank; marks.push({ yaw: t.yaw[l], color: '#f2b35b', o: a ? 1 : .55 }); }
      else f = C.gone;
      cells[l].setAttribute('fill', f);
    }
    ring.setMarks(marks);
    nA.textContent = na; nB.textContent = nb; nR.textContent = s.recent.length; nS.textContent = s.committed;
    $('#kda-fill').style.opacity = RM ? 0.6 : (0.25 + 0.6 * s.committed / N).toFixed(2);
  });
}

/* REAL TIME */
function live(R, stats) {
  const v = $('#live-video'), sec = $('#live');
  lazyPoster(v, R.poster, sec);
  playWhenVisible(v, sec, { src: R.src });
  if (RM) v.controls = true;
  $('#live-note').textContent = `Recorded from the interactive demo: ${R.scene}. Over this session, the median time to generate a 1.25 s chunk was ${R.s_chunk_median_run.toFixed(2)} s on one H200.`;
  const caps = {}; document.querySelectorAll('.kc').forEach(k => caps[k.dataset.key] = k);
  const sc = $('#live-sc'); let lastF = -1;
  loopWhileVisible(sec, () => {
    const f = clamp(Math.floor(v.currentTime * R.fps), 0, R.keys.length - 1);
    if (f === lastF) return; lastF = f;
    const on = new Set((R.keys[f] || '').split('+').filter(Boolean));
    for (const k in caps) caps[k].classList.toggle('on', on.has(k));
    sc.textContent = R.s_chunk[Math.min(Math.floor(f / 20), R.s_chunk.length - 1)].toFixed(2);
  });
  const dl = $('#stats');
  stats.forEach(s => {
    const d = document.createElement('div'); d.className = 'reveal';
    d.innerHTML = `<dt><span class="num"></span><small></small></dt><dd></dd>`;
    d.querySelector('.num').textContent = s.value; d.querySelector('small').textContent = s.unit; d.querySelector('dd').textContent = s.label;
    dl.appendChild(d); io.observe(d);
  });
}

/* WALL + LIGHTBOX */
function wall(list, names) {
  const W = $('#wall');
  const vio = new IntersectionObserver(es => es.forEach(e => {
    const tile = e.target, vid = tile.querySelector('video');
    if (e.isIntersecting) {
      if (!vid.src) { vid.src = tile.dataset.clip; const off = +tile.dataset.off || 0; vid.addEventListener('loadedmetadata', () => { try { vid.currentTime = off % Math.max(1, vid.duration - 0.1); } catch {} }, { once: true }); }
      if (!RM) vid.play().then(() => tile.classList.add('playing')).catch(() => {});
    } else { vid.pause(); }
  }), { rootMargin: '120px 0px', threshold: 0.2 });
  list.forEach((it, idx) => {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'tile ' + (it.size || ''); b.dataset.clip = it.clip; b.dataset.off = (idx * 1.7).toFixed(2);
    b.setAttribute('aria-label', `${it.title}, ${it.style}. Open camera paths`);
    b.innerHTML = `<img loading="lazy" decoding="async" alt=""><video muted loop playsinline preload="none" aria-hidden="true"></video><span class="cap"><span></span><small></small></span>`;
    b.querySelector('img').src = it.poster;
    b.querySelector('.cap span').textContent = it.title; b.querySelector('.cap small').textContent = it.style;
    b.onclick = () => openLB(it, names, b);
    W.appendChild(b); vio.observe(b);
  });
}
const lb = $('#lb'), lbv = $('#lb-video');
let lbReturn = null;
async function openLB(it, names, from) {
  lbReturn = from;
  const np = it.trajectories.filter(x => x.traj).length;
  $('#lb-title').textContent = it.title; $('#lb-style').textContent = it.style + (np ? ' · ' + np + (np > 1 ? ' camera paths' : ' camera path') : '');
  const P = $('#lb-paths'); P.textContent = '';
  const pick = k => {
    const tr = it.trajectories[k];
    lbv.poster = tr.poster; lbv.src = tr.src; lbv.play().catch(() => {});
    [...P.children].forEach((b, j) => b.setAttribute('aria-current', j === k));
  };
  for (let k = 0; k < it.trajectories.length; k++) {
    const tr = it.trajectories[k];
    if (!tr.traj) continue; // clip without a camera-path file: video only
    const t = await loadTraj(tr.traj);
    const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'listitem');
    const svg = el('svg', { viewBox: '-1 -1 2 2' });
    drawPath(svg, t);
    b.appendChild(svg);
    const d = document.createElement('div');
    d.innerHTML = '<b></b><small></small>';
    d.querySelector('b').textContent = names[tr.v] || tr.v;
    const walked = t.x.reduce((a, _, i) => i ? a + Math.hypot(t.x[i] - t.x[i - 1], t.z[i] - t.z[i - 1]) : 0, 0);
    d.querySelector('small').textContent = `${Math.round(t.cum[t.n - 1])}° turned · ${walked.toFixed(1)} m · ${((t.n - 1) * t.dt).toFixed(0)} s`;
    b.appendChild(d); b.onclick = () => pick(k);
    P.appendChild(b);
  }
  lb.hidden = false; requestAnimationFrame(() => lb.classList.add('open'));
  document.body.style.overflow = 'hidden';
  pick(0); $('#lb-x').focus();
}
function drawPath(svg, t) {
  const xs = t.x, zs = t.z.map(z => -z);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const span = Math.max(x1 - x0, z1 - z0, 1.2), cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, s = 1.5 / span;
  el('circle', { r: 0.95, fill: '#18181b' }, svg);
  const pts = xs.map((x, i) => `${((x - cx) * s).toFixed(3)},${((zs[i] - cz) * s).toFixed(3)}`).join(' ');
  el('polyline', { points: pts, fill: 'none', stroke: '#8fd3ff', 'stroke-width': 0.07, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  const sx = (xs[0] - cx) * s, sz = (zs[0] - cz) * s;
  el('circle', { cx: sx, cy: sz, r: 0.2, fill: 'none', stroke: '#f2b35b', 'stroke-width': 0.05, 'stroke-dasharray': '0.08 0.05' }, svg);
  el('path', { d: `M${sx} ${sz}l-0.12 0.16h0.24z`, fill: '#f2b35b', transform: `translate(0 -0.02)` }, svg);
}
function closeLB() {
  lb.classList.remove('open'); lbv.pause(); lbv.removeAttribute('src'); lbv.load();
  setTimeout(() => { lb.hidden = true; }, RM ? 0 : 250);
  document.body.style.overflow = '';
  if (lbReturn) lbReturn.focus();
}
$('#lb-x').onclick = closeLB;
lb.addEventListener('click', e => { if (e.target === lb) closeLB(); });
addEventListener('keydown', e => { if (e.key === 'Escape' && !lb.hidden) closeLB(); });
})();
