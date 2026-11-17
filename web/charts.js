/* Petits graphiques SVG, aux couleurs du thème (aucune bibliothèque externe). */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* Courbe d'évaluation d'une partie : blanc au-dessus, noir en dessous. */
  function evalChart(el, cps, { current = 0, marks = {}, onClick = null, orientation = 'w' } = {}) {
    const W = 600, H = 96, n = Math.max(1, cps.length - 1);
    const y = (cp) => {
      const wp = cp === null || cp === undefined ? 50 : window.winPct(cp);
      const v = orientation === 'w' ? wp : 100 - wp;
      return H - (v / 100) * H;
    };
    const pts = cps.map((cp, i) => [(i / n) * W, y(cp)]);
    const top = orientation === 'w' ? 'var(--black-bar)' : 'var(--white-bar)';
    const bottom = orientation === 'w' ? 'var(--white-bar)' : 'var(--black-bar)';
    let path = `M0,${H} ` + pts.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') + ` L${W},${H} Z`;
    let dots = '';
    for (const [i, cls] of Object.entries(marks)) {
      const p = pts[i];
      if (!p) continue;
      dots += `<circle cx="${p[0]}" cy="${p[1]}" r="4.5" fill="var(--c-${cls})" stroke="var(--sheet)" stroke-width="1.5"/>`;
    }
    const cx = (current / n) * W;
    el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:96px">
      <rect width="${W}" height="${H}" fill="${top}"/>
      <path d="${path}" fill="${bottom}"/>
      <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="var(--faint)" stroke-dasharray="3 4" stroke-width="1"/>
      <line x1="${cx}" x2="${cx}" y1="0" y2="${H}" stroke="var(--pen)" stroke-width="2.5"/>
      ${dots}</svg>`;
    if (onClick) {
      el.onclick = (e) => {
        const r = el.querySelector('svg').getBoundingClientRect();
        onClick(Math.round(((e.clientX - r.left) / r.width) * n));
      };
    }
  }

  /* Courbes dans le temps : series = [{name, color, points:[[t,v],...]}] */
  function lineChart(el, series, { height = 230, fmtY = (v) => v, minY = null, maxY = null } = {}) {
    const W = Math.max(320, el.clientWidth || 600), H = height, padL = 44, padR = 12, padT = 12, padB = 26;
    const all = series.flatMap((s) => s.points);
    if (!all.length) { el.innerHTML = '<div class="empty">Pas encore de données.</div>'; return; }
    const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
    let x0 = Math.min(...xs), x1 = Math.max(...xs);
    if (x1 === x0) x1 = x0 + 1;
    let y0 = minY ?? Math.min(...ys), y1 = maxY ?? Math.max(...ys);
    const padY = (y1 - y0) * 0.08 || 10;
    y0 -= padY; y1 += padY;
    const X = (t) => padL + ((t - x0) / (x1 - x0)) * (W - padL - padR);
    const Y = (v) => padT + (1 - (v - y0) / (y1 - y0)) * (H - padT - padB);
    let g = '';
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = y0 + ((y1 - y0) * i) / ticks;
      g += `<line x1="${padL}" x2="${W - padR}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--rule)"/>`;
      g += `<text x="${padL - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${esc(fmtY(Math.round(v)))}</text>`;
    }
    const months = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
    for (let i = 0; i <= 4; i++) {
      const t = x0 + ((x1 - x0) * i) / 4;
      const d = new Date(t * 1000);
      g += `<text x="${X(t)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}" font-size="11" fill="var(--muted)">${months[d.getMonth()]} ${String(d.getFullYear()).slice(2)}</text>`;
    }
    for (const s of series) {
      if (!s.points.length) continue;
      const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ');
      g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      const last = s.points[s.points.length - 1];
      g += `<circle cx="${X(last[0])}" cy="${Y(last[1])}" r="3.5" fill="${s.color}"/>`;
    }
    el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" style="height:${H}px">${g}</svg>` +
      (series.length > 1 ? `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>` : '');
  }

  /* Barres horizontales : items = [{label, value, text, bad}] */
  function hbars(el, items, { max = null } = {}) {
    if (!items.length) { el.innerHTML = '<div class="empty">Pas encore de données.</div>'; return; }
    const m = max ?? Math.max(...items.map((i) => i.value || 0), 1);
    el.innerHTML = `<div class="hbars">${items.map((i) => `
      <div class="hbar"><span class="ink2">${esc(i.label)}</span>
        <div class="track"><div class="${i.bad ? 'bad' : ''}" style="width:${Math.max(1.5, (100 * (i.value || 0)) / m)}%"></div></div>
        <span class="v">${esc(i.text ?? i.value)}</span></div>`).join('')}</div>`;
  }

  window.Charts = { evalChart, lineChart, hbars, css };
})();
