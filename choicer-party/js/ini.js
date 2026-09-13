// Parser for the Godot-style ConfigFile .ini cards a Choicer Voicer package
// ships per line:
//
//   [data]
//   caption="And what he said is, \"you are a celebrity!\""
//   image="001_line_01.png"
//   dub_timestamps=[0.000]
//   dub_characters=["Kanye"]
//
// Values are Godot Variant literals. Every value seen in the wild (quoted
// strings with backslash escapes, numbers, bools, arrays of those) is also
// valid JSON, so JSON.parse does the heavy lifting with a plain-string
// fallback for anything exotic.

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

function parseValue(s) {
  if (s === '') return '';
  try { return JSON.parse(s); } catch { /* not JSON, fall through */ }
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

/** The `[data]` table of a card, or the whole file when it has no sections. */
export function iniData(text) {
  const parsed = parseIni(text);
  return parsed.data ?? parsed;
}
