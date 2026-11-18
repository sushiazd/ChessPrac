/* Coups de théorie : les positions des ouvertures répertoriées (base « chess-openings » de Lichess, domaine public).
   data/book.json est généré une fois pour toutes par tools/build_browser_data.py à partir de data/ouvertures/*.tsv. */

let known = null;   // position (EPD) -> nom de l'ouverture
let loading = null;

export function load() {
  if (!loading) {
    loading = fetch(new URL('./data/book.json', import.meta.url)).then((r) => r.json()).then((d) => {
      known = new Map();
      for (const [name, keys] of d.names.map((n, i) => [n, d.groups[i]])) for (const k of keys) known.set(k, name);
    });
  }
  return loading;
}

const EARLY_PLIES = 8;      // les 4 premiers coups de chaque camp : un coup sain y est « de la théorie »
const EARLY_MAX_DROP = 6;   // ... s'il ne perd presque rien selon Stockfish

/** Pour chaque coup de la partie (position après le coup) : le nom d'ouverture si c'est encore de la théorie,
    sinon null. La théorie s'arrête au premier coup qui en sort. */
export function bookPlies(fensAfter, drops = null) {
  const out = [];
  let inside = true;
  let lastName = null;
  fensAfter.forEach((fen, i) => {
    if (!inside) { out.push(null); return; }
    let name = known ? known.get(fen.split(' ').slice(0, 4).join(' ')) || null : null;
    const drop = drops && i < drops.length ? drops[i] : null;
    if (name === null && i < EARLY_PLIES && drop !== null && drop !== undefined && drop < EARLY_MAX_DROP) {
      name = lastName || 'Début de partie';
    }
    if (name === null) inside = false; else lastName = name;
    out.push(name);
  });
  return out;
}
