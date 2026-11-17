/* Échiquier maison : glisser-déposer ou clic-clic, flèches, surlignages, promotion, animation des pièces.
   Toute la logique des échecs reste côté Python (coups légaux fournis par l'API) : ce fichier ne fait qu'afficher. */
(function () {
  const FILES = 'abcdefgh';
  const URL = {};
  for (const [k, svg] of Object.entries(window.CHESS_PIECE_SVGS || {})) {
    URL[k] = 'url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '")';
  }
  const SVGNS = 'http://www.w3.org/2000/svg';

  function parseFen(fen) {
    const parts = fen.split(' ');
    const map = {};
    parts[0].split('/').forEach((row, r) => {
      let f = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) f += +ch;
        else { map[FILES[f] + (8 - r)] = ch; f++; }
      }
    });
    return { map, turn: parts[1] || 'w' };
  }
  const colorOf = (p) => (p === p.toUpperCase() ? 'w' : 'b');

  class Board {
    constructor(el, opts = {}) {
      this.el = el;
      el.classList.add('board');
      el.innerHTML = '';
      this.orientation = opts.orientation || 'w';
      this.onMove = opts.onMove || null;
      this.movable = opts.movable === undefined ? null : opts.movable; // 'w' | 'b' | 'both' | null
      this.coords = opts.coords !== false;
      this.pieces = {}; this.map = {}; this.legal = []; this.marks = {};
      this.lastMove = null; this.check = null; this.sel = null; this.drag = null; this.arrowList = [];
      this.squaresEl = document.createElement('div');
      this.squaresEl.className = 'squares';
      el.appendChild(this.squaresEl);
      this.arrowSvg = document.createElementNS(SVGNS, 'svg');
      this.arrowSvg.setAttribute('class', 'arrows');
      this.arrowSvg.setAttribute('viewBox', '0 0 800 800');
      el.appendChild(this.arrowSvg);
      this._build();
      if (opts.interactive !== false) {
        this._onDown = (e) => this._down(e);
        this._onMove = (e) => this._dragMove(e);
        this._onUp = (e) => this._up(e);
        el.addEventListener('pointerdown', this._onDown);
        window.addEventListener('pointermove', this._onMove);
        window.addEventListener('pointerup', this._onUp);
      }
      if (opts.fen) this.set({ fen: opts.fen, animate: false });
    }

    destroy() {
      if (this._onMove) {
        window.removeEventListener('pointermove', this._onMove);
        window.removeEventListener('pointerup', this._onUp);
      }
    }

    _build() {
      this.squaresEl.innerHTML = '';
      this.sqEl = {};
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const sq = this.orientation === 'w' ? FILES[x] + (8 - y) : FILES[7 - x] + (y + 1);
          const d = document.createElement('div');
          const fi = FILES.indexOf(sq[0]), ra = +sq[1];
          d.className = 'sq ' + ((fi + ra) % 2 === 0 ? 'd' : 'l');
          if (this.coords) {
            if (y === 7) d.insertAdjacentHTML('beforeend', `<span class="coord file">${sq[0]}</span>`);
            if (x === 0) d.insertAdjacentHTML('beforeend', `<span class="coord rank">${sq[1]}</span>`);
          }
          this.sqEl[sq] = d;
          this.squaresEl.appendChild(d);
        }
      }
    }

    _xy(sq) {
      const f = FILES.indexOf(sq[0]), r = +sq[1] - 1;
      return this.orientation === 'w' ? [f, 7 - r] : [7 - f, r];
    }

    _sqAt(cx, cy) {
      const r = this.el.getBoundingClientRect();
      const x = Math.floor(((cx - r.left) / r.width) * 8), y = Math.floor(((cy - r.top) / r.height) * 8);
      if (x < 0 || x > 7 || y < 0 || y > 7) return null;
      return this.orientation === 'w' ? FILES[x] + (8 - y) : FILES[7 - x] + (y + 1);
    }

    _place(el, sq, instant) {
      const [x, y] = this._xy(sq);
      if (instant) el.style.transition = 'none';
      el.style.transform = `translate(${x * 100}%, ${y * 100}%)`;
      if (instant) { void el.offsetWidth; el.style.transition = ''; }
    }

    _newPiece(p) {
      const el = document.createElement('div');
      el.className = 'piece';
      el.dataset.p = p;
      el.style.backgroundImage = URL[p];
      this.el.appendChild(el);
      return el;
    }

    /* Nouvelle position. Les pièces qui ont bougé glissent jusqu'à leur case. */
    set({ fen, lastMove = null, check = null, legal = null, animate = true }) {
      const { map, turn } = parseFen(fen);
      const old = { ...this.pieces };
      const next = {};
      for (const sq of Object.keys(map)) {
        if (old[sq] && old[sq].dataset.p === map[sq]) { next[sq] = old[sq]; delete old[sq]; }
      }
      for (const sq of Object.keys(map)) {
        if (next[sq]) continue;
        const p = map[sq];
        let src = null;
        if (lastMove && lastMove[1] === sq && old[lastMove[0]] && colorOf(old[lastMove[0]].dataset.p) === colorOf(p)) src = lastMove[0];
        if (!src) src = Object.keys(old).find((k) => old[k].dataset.p === p && !map[k]) || null;
        let el;
        if (src && animate) {
          el = old[src]; delete old[src];
          if (el.dataset.p !== p) { el.dataset.p = p; el.style.backgroundImage = URL[p]; }
          this._place(el, sq, false);
        } else {
          if (src) { old[src].remove(); delete old[src]; }
          el = this._newPiece(p);
          this._place(el, sq, true);
        }
        next[sq] = el;
      }
      for (const el of Object.values(old)) el.remove();
      this.pieces = next; this.map = map; this.turn = turn; this.fen = fen;
      this.legal = legal || []; this.lastMove = lastMove; this.check = check; this.sel = null;
      this._paint();
    }

    setLegal(legal) { this.legal = legal || []; this._paint(); }

    setOrientation(o) {
      if (o === this.orientation) return;
      this.orientation = o;
      this._build();
      for (const [sq, el] of Object.entries(this.pieces)) this._place(el, sq, true);
      this._paint();
      this._drawArrows();
    }

    flip() { this.setOrientation(this.orientation === 'w' ? 'b' : 'w'); }

    mark(sq, cls) { this.marks[sq] = cls; this._paint(); }
    clearMarks() { this.marks = {}; this._paint(); }

    _targets(sq) {
      return [...new Set(this.legal.filter((u) => u.slice(0, 2) === sq).map((u) => u.slice(2, 4)))];
    }

    _canMove(sq) {
      const p = this.map[sq];
      if (!p || !this.onMove || !this.movable) return false;
      const c = colorOf(p);
      if (c !== this.turn) return false;
      if (this.movable !== 'both' && c !== this.movable) return false;
      return this.legal.some((u) => u.slice(0, 2) === sq);
    }

    _paint() {
      const targets = this.sel ? this._targets(this.sel) : [];
      for (const [sq, d] of Object.entries(this.sqEl)) {
        d.classList.toggle('last', !!this.lastMove && this.lastMove.includes(sq));
        d.classList.toggle('sel', sq === this.sel);
        d.classList.toggle('check', sq === this.check);
        d.classList.toggle('good', this.marks[sq] === 'good');
        d.classList.toggle('wrong', this.marks[sq] === 'wrong');
        d.querySelectorAll('.dot,.ring').forEach((n) => n.remove());
        if (targets.includes(sq)) d.insertAdjacentHTML('beforeend', this.map[sq] ? '<i class="ring"></i>' : '<i class="dot"></i>');
      }
      for (const [sq, el] of Object.entries(this.pieces)) el.classList.toggle('movable', this._canMove(sq));
    }

    _down(e) {
      if (e.button !== 0) return;
      const sq = this._sqAt(e.clientX, e.clientY);
      if (!sq) return;
      if (this.sel && sq !== this.sel && this._targets(this.sel).includes(sq)) { this._try(this.sel, sq, false); return; }
      if (this._canMove(sq)) {
        this.sel = sq;
        this._paint();
        this.drag = { sq, el: this.pieces[sq], x0: e.clientX, y0: e.clientY, moved: false };
        e.preventDefault();
      } else if (this.sel) {
        this.sel = null;
        this._paint();
      }
    }

    _dragMove(e) {
      const d = this.drag;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
      d.moved = true;
      d.el.classList.add('dragging');
      const r = this.el.getBoundingClientRect();
      const s = r.width / 8;
      d.el.style.transform = `translate(${e.clientX - r.left - s / 2}px, ${e.clientY - r.top - s / 2}px)`;
    }

    _up(e) {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      if (!d.moved) return;
      d.el.classList.remove('dragging');
      const sq = this._sqAt(e.clientX, e.clientY);
      if (sq && sq !== d.sq && this._targets(d.sq).includes(sq)) this._try(d.sq, sq, true);
      else this._place(d.el, d.sq, true);
    }

    async _try(from, to, dragged) {
      const cands = this.legal.filter((u) => u.slice(0, 4) === from + to);
      if (!cands.length) return;
      let uci = cands[0];
      if (cands.length > 1) {
        uci = await this._promo(from, to);
        if (!uci) { this._place(this.pieces[from], from, true); this.sel = null; this._paint(); return; }
      }
      // Affichage immédiat du coup ; l'appelant confirme ensuite avec la vraie position.
      const el = this.pieces[from];
      if (this.pieces[to]) this.pieces[to].remove();
      delete this.pieces[from];
      this.pieces[to] = el;
      this.map[to] = this.map[from];
      delete this.map[from];
      this._place(el, to, dragged);
      this.lastMove = [from, to];
      this.legal = [];
      this.sel = null;
      this._paint();
      if (this.onMove) this.onMove(uci);
    }

    _promo(from, to) {
      return new Promise((resolve) => {
        const c = colorOf(this.map[from]);
        const ov = document.createElement('div');
        ov.className = 'promo';
        const box = document.createElement('div');
        for (const p of ['q', 'r', 'b', 'n']) {
          const b = document.createElement('button');
          const key = c === 'w' ? p.toUpperCase() : p;
          b.style.backgroundImage = URL[key];
          b.title = { q: 'Dame', r: 'Tour', b: 'Fou', n: 'Cavalier' }[p];
          b.onclick = (ev) => { ev.stopPropagation(); ov.remove(); resolve(from + to + p); };
          box.appendChild(b);
        }
        ov.appendChild(box);
        ov.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); if (ev.target === ov) { ov.remove(); resolve(null); } });
        this.el.appendChild(ov);
      });
    }

    /* Flèches : [{from:'e2', to:'e4', color:'pen'|'ok'|'bad'|css, opacity}] */
    setArrows(list) { this.arrowList = list || []; this._drawArrows(); }

    _drawArrows() {
      const colors = { pen: 'var(--pen)', ok: 'var(--ok)', bad: 'var(--bad)', warn: 'var(--warn)', ink: 'var(--ink-2)' };
      this.arrowSvg.innerHTML = '';
      for (const a of this.arrowList) {
        if (!a.from || !a.to || a.from === a.to) continue;
        const [x1, y1] = this._xy(a.from).map((v) => v * 100 + 50);
        const [x2, y2] = this._xy(a.to).map((v) => v * 100 + 50);
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const len = Math.hypot(x2 - x1, y2 - y1);
        const head = 34, w = a.width || 15;
        const ex = x1 + Math.cos(ang) * (len - head), ey = y1 + Math.sin(ang) * (len - head);
        const sx = x1 + Math.cos(ang) * 22, sy = y1 + Math.sin(ang) * 22;
        const col = colors[a.color] || a.color || colors.pen;
        const g = document.createElementNS(SVGNS, 'g');
        g.setAttribute('opacity', a.opacity ?? 0.82);
        const line = document.createElementNS(SVGNS, 'line');
        Object.entries({ x1: sx, y1: sy, x2: ex, y2: ey, stroke: col, 'stroke-width': w, 'stroke-linecap': 'round' })
          .forEach(([k, v]) => line.setAttribute(k, v));
        const px = Math.cos(ang + Math.PI / 2), py = Math.sin(ang + Math.PI / 2);
        const tipx = x1 + Math.cos(ang) * (len - 6), tipy = y1 + Math.sin(ang) * (len - 6);
        const poly = document.createElementNS(SVGNS, 'polygon');
        poly.setAttribute('points', `${tipx},${tipy} ${ex + px * 26},${ey + py * 26} ${ex - px * 26},${ey - py * 26}`);
        poly.setAttribute('fill', col);
        g.appendChild(line); g.appendChild(poly);
        this.arrowSvg.appendChild(g);
      }
    }

    flash(kind) {
      this.el.classList.remove('flash-ok', 'flash-bad');
      void this.el.offsetWidth;
      this.el.classList.add(kind === 'ok' ? 'flash-ok' : 'flash-bad');
    }
  }

  function winPct(cp) {
    cp = Math.max(-1000, Math.min(1000, cp));
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
  }

  function evalText(cp, mate) {
    if (mate !== null && mate !== undefined) return mate === 0 ? '#' : 'M' + Math.abs(mate);
    const v = Math.abs(cp) / 100;
    return v >= 10 ? v.toFixed(0) : v.toFixed(1);
  }

  class EvalBar {
    constructor(el) {
      this.el = el;
      el.className = 'evalbar';
      el.innerHTML = '<div class="w"></div><span class="t top"></span><span class="t bot"></span>';
    }
    set(cp, mate, orientation = 'w') {
      if (cp === null || cp === undefined) { this.el.style.opacity = .35; return; }
      this.el.style.opacity = 1;
      const wp = winPct(cp);
      this.el.classList.toggle('flip', orientation === 'b');
      this.el.querySelector('.w').style.height = wp + '%';
      const t = evalText(cp, mate);
      const whiteBetter = cp >= 0;
      const top = this.el.querySelector('.top'), bot = this.el.querySelector('.bot');
      // Le chiffre s'affiche du côté de celui qui a l'avantage.
      const whiteAtBottom = orientation === 'w';
      top.textContent = whiteBetter !== whiteAtBottom ? t : '';
      bot.textContent = whiteBetter === whiteAtBottom ? t : '';
      top.style.color = whiteAtBottom ? 'var(--white-bar)' : 'var(--black-bar)';
      bot.style.color = whiteAtBottom ? 'var(--black-bar)' : 'var(--white-bar)';
    }
  }

  window.Board = Board;
  window.EvalBar = EvalBar;
  window.winPct = winPct;
  window.evalText = evalText;
  window.parseFen = parseFen;
})();
