// Parser for the Godot-style ConfigFile cards a Choicer Voicer package ships
// per line (as .txt in the game's native layout, .ini in exports):
//
//   [data]
//
//   caption="“Shut up! Just shut up, you idiot!”"
//   image="woody.png"
//   dub_timestamps=[07.770]
//   dub_characters=["Woody"]
//
// Values are Godot Variant literals. Most are valid JSON, but Godot happily
// writes numbers with a leading zero (`05.865`), which JSON rejects, so arrays
// and scalars get a lenient second pass.

export function parseIni(text) {
  const root = {};
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const head = line.match(/^\[(.+)\]$/);
    if (head) {
      section = head[1].trim();
      root[section] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = parseValue(line.slice(eq + 1).trim());
    (section ? root[section] : root)[key] = value;
  }
  return root;
}

export function parseValue(s) {
  if (s === '') return '';
  try { return JSON.parse(s); } catch { /* not strict JSON, fall through */ }
  if (s.startsWith('[') && s.endsWith(']')) return splitTopLevel(s.slice(1, -1)).map(parseScalar);
  return parseScalar(s);
}

function parseScalar(s) {
  s = s.trim();
  if (s === '') return '';
  try { return JSON.parse(s); } catch { /* fall through */ }
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\(.)/g, '$1');
  if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  return s;
}

/** Split on commas that are not inside a quoted string. */
function splitTopLevel(s) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      cur += c;
      if (c === '\\' && i + 1 < s.length) { cur += s[++i]; continue; }
      if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true; cur += c;
    } else if (c === ',') {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim() !== '' || out.length) out.push(cur);
  return out;
}

/** The `[data]` table of a card, or the whole file when it has no sections. */
export function iniData(text) {
  const parsed = parseIni(text);
  return parsed.data ?? parsed;
}
