import { DurableObject } from "cloudflare:workers";
import {
  HttpError, json, readJson, bearer, clip, normCode, firstName,
  randomId, randomPin, sha256, hmac, timingSafeEqual, shuffle,
} from "./util.js";

const CATEGORIES = ["Appetizer", "Main", "Side", "Dessert", "Drinks", "Other"];
const MIN_SANTAS = 3;
const ADMIN_SESSION_MS = 7 * 24 * 3600e3;

function freshState() {
  return {
    party: { details: "", budget: "", santaNote: "", code: "", rsvpBy: null }, // rsvpBy: epoch ms
    dates: [],       // { id, date: "YYYY-MM-DD", time: "HH:MM" | "" }
    finalDateId: null,
    foods: [],       // { id, name, category, slots }
    guests: [],      // see newGuest()
    draw: null,      // { at, pairs: { giverId: receiverId } } — only leaves this object for the giver, after PIN sign-in
  };
}

function newGuest(name, household, pin) {
  return {
    id: randomId(), name, household, pin,  // pin: the Secret Santa sign-in the host texts out
    claimedAt: null, respondedAt: null,
    rank: [], noDates: false,              // rank: date ids, favourite first
    foodId: null, writeIn: "", noFood: false,
    santa: true, hints: "",
  };
}

function sameHousehold(a, b) {
  return !!a.household && !!b.household && a.household.toLowerCase() === b.household.toLowerCase();
}

// One gift chain through everybody when possible (no A↔B swaps), otherwise any
// assignment that keeps people away from themselves and their own household.
function makePairs(players) {
  const n = players.length;
  for (let attempt = 0; attempt < 2000; attempt++) {
    const order = shuffle(players.slice());
    if (order.every((g, i) => !sameHousehold(g, order[(i + 1) % n]))) {
      return Object.fromEntries(order.map((g, i) => [g.id, order[(i + 1) % n].id]));
    }
  }
  for (let attempt = 0; attempt < 20000; attempt++) {
    const recv = shuffle(players.slice());
    if (players.every((g, i) => g.id !== recv[i].id && !sameHousehold(g, recv[i]))) {
      return Object.fromEntries(players.map((g, i) => [g.id, recv[i].id]));
    }
  }
  throw new HttpError(409, "No valid draw is possible: too many participants share a household.");
}

export class Party extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.hits = new Map();
    this.chain = Promise.resolve();
  }

  // One request at a time. Handlers await hashing and storage between reading
  // and writing state, and a party's traffic is tiny, so plain serialization is
  // simpler than reasoning about interleavings.
  serial(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  async fetch(request) {
    return this.serial(async () => {
      try {
        return await this.route(request);
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.message }, err.status);
        console.error(err?.stack || err);
        return json({ error: "Something went wrong on the server." }, 500);
      }
    });
  }

  async load() {
    if (!this.s) {
      this.s = (await this.ctx.storage.get("state")) || freshState();
      if (this.migrate()) await this.save();
    }
    return this.s;
  }

  // Saves from before ranked dates and PINs. Saved straight away so a PIN the
  // host has already seen can't change under them.
  migrate() {
    const s = this.s;
    let changed = false;
    if (s.party.rsvpBy === undefined) s.party.rsvpBy = null;
    for (const g of s.guests) {
      if (!Array.isArray(g.rank)) Object.assign(g, { rank: [], noDates: false });
      if ("votes" in g) delete g.votes;
      if (!g.pin) {
        g.pin = this.newPin();
        changed = true;
      }
    }
    return changed;
  }

  newPin() {
    const taken = new Set(this.s.guests.map((g) => g.pin));
    let pin;
    do pin = randomPin(); while (taken.has(pin));
    return pin;
  }

  async save() {
    await this.ctx.storage.put("state", this.s);
  }

  // Failure counter per client IP. Lives in memory, so it resets when the
  // object is evicted — enough to stop someone hammering the code box.
  bucket(request, name, max, windowMs) {
    const ip = request.headers.get("CF-Connecting-IP") || "local";
    const key = `${name}:${ip}`;
    const now = Date.now();
    let b = this.hits.get(key);
    if (!b || b.reset < now) this.hits.set(key, (b = { n: 0, reset: now + windowMs }));
    if (b.n >= max) throw new HttpError(429, "Too many tries. Wait a few minutes and try again.");
    return b;
  }

  async route(request) {
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    const method = request.method;
    const body = method === "GET" || method === "DELETE" ? {} : await readJson(request);
    await this.load();

    if (path === "/api/info" && method === "GET") return json({ open: !!this.s.party.code, rsvpBy: this.s.party.rsvpBy });
    if (path === "/api/enter" && method === "POST") return this.enter(request, body);
    if (path === "/api/santa" && method === "POST") return this.santaLogin(request, body);
    if (path === "/api/claim" && method === "POST") return this.claim(request, body);
    if (path === "/api/me") {
      const g = await this.guestFromAuth(request);
      if (method === "GET") return json(this.guestView(g));
      if (method === "PUT") return this.updateGuest(g, body);
    }
    if (path === "/api/admin/login" && method === "POST") return this.adminLogin(request, body);
    if (path.startsWith("/api/admin/")) {
      await this.requireAdmin(request);
      return this.admin(path.slice("/api/admin/".length), method, body);
    }
    throw new HttpError(404, "Not found.");
  }

  // ---------- guests ----------

  checkCode(request, code) {
    const b = this.bucket(request, "code", 12, 10 * 60e3);
    const want = normCode(this.s.party.code);
    if (!want) throw new HttpError(403, "The party isn't open yet.");
    if (normCode(code) !== want) {
      b.n++;
      throw new HttpError(403, "Incorrect party code.");
    }
  }

  enter(request, body) {
    this.checkCode(request, body.code);
    return json({
      guests: this.s.guests.map((g) => ({ id: g.id, name: g.name })),
    });
  }

  async claim(request, body) {
    this.checkCode(request, body.code);
    const g = this.s.guests.find((x) => x.id === body.guestId);
    if (!g) throw new HttpError(404, "That name is no longer on the guest list.");
    if (!g.claimedAt) {
      g.claimedAt = Date.now();
      await this.save();
    }
    return json({ token: `${g.id}.${await this.guestSig(g.id)}` });
  }

  // Guests sign in by picking their name, from as many devices as they like, so
  // the token is just their id signed with a key only the Worker holds.
  guestSig(id) {
    return hmac(this.adminSecret(), `guest:${id}`);
  }

  async guestFromAuth(request) {
    const [id, sig] = bearer(request).split(".");
    const g = id && sig && this.s.guests.find((x) => x.id === id);
    if (g && timingSafeEqual(sig, await this.guestSig(id))) return g;
    throw new HttpError(401, "This device is no longer signed in. Enter the party code again.");
  }

  // The RSVP page never carries the match: that needs the PIN (santaLogin).
  guestView(g) {
    const s = this.s;
    return {
      me: {
        id: g.id, name: g.name, rank: g.rank, noDates: g.noDates, foodId: g.foodId, writeIn: g.writeIn, noFood: g.noFood,
        santa: g.santa, hints: g.hints, respondedAt: g.respondedAt,
      },
      party: { details: s.party.details, budget: s.party.budget, santaNote: s.party.santaNote, rsvpBy: s.party.rsvpBy },
      dates: s.dates,
      finalDate: s.dates.find((d) => d.id === s.finalDateId) || null,
      categories: CATEGORIES,
      foods: s.foods.map((f) => {
        const takers = s.guests.filter((x) => x.foodId === f.id);
        return { ...f, takenBy: takers.map((x) => firstName(x.name)), left: Math.max(0, f.slots - takers.length) };
      }),
      extras: s.guests
        .filter((x) => x.id !== g.id && x.writeIn)
        .map((x) => ({ who: firstName(x.name), dish: x.writeIn })),
      santa: { drawn: !!s.draw, inDraw: !!s.draw?.pairs[g.id] },
    };
  }

  async santaLogin(request, body) {
    const s = this.s;
    if (!s.draw) throw new HttpError(409, "Secret Santa isn't live yet.");
    const b = this.bucket(request, "pin", 10, 10 * 60e3);
    const pin = String(body.pin ?? "").replace(/\D/g, "");
    const g = pin.length === 6 && s.guests.find((x) => x.pin === pin);
    if (!g) {
      b.n++;
      throw new HttpError(403, "That PIN doesn't match. Check the text from the host.");
    }
    const receiver = s.guests.find((x) => x.id === s.draw.pairs[g.id]);
    return json({
      name: g.name,
      match: receiver ? { name: receiver.name, hints: receiver.hints } : null,
      party: { budget: s.party.budget, santaNote: s.party.santaNote },
      finalDate: s.dates.find((d) => d.id === s.finalDateId) || null,
    });
  }

  async updateGuest(g, b) {
    const s = this.s;
    const next = {};

    if ("rank" in b) {
      if (!Array.isArray(b.rank)) throw new HttpError(400, "Malformed ranking.");
      const ids = new Set(s.dates.map((d) => d.id));
      next.rank = [...new Set(b.rank)].filter((id) => ids.has(id));
      if (next.rank.length) next.noDates = false;
    }
    if ("noDates" in b) {
      next.noDates = !!b.noDates;
      if (next.noDates) next.rank = [];
    }

    if ("food" in b) {
      const f = b.food || {};
      Object.assign(next, { foodId: null, writeIn: "", noFood: false });
      if (f.dish) {
        const dish = s.foods.find((x) => x.id === f.dish);
        if (!dish) throw new HttpError(404, "That dish is no longer listed.");
        if (g.foodId !== dish.id && s.guests.filter((x) => x.foodId === dish.id).length >= dish.slots) {
          throw new HttpError(409, `${dish.name} is no longer available.`);
        }
        next.foodId = dish.id;
      } else if (typeof f.other === "string" && f.other.trim()) {
        next.writeIn = clip(f.other, 80);
      } else if (f.none) {
        next.noFood = true;
      }
    }

    if ("santa" in b) {
      const v = !!b.santa;
      if (s.draw && v !== g.santa) throw new HttpError(409, "Names have already been drawn.");
      next.santa = v;
    }
    if ("hints" in b) next.hints = clip(b.hints, 600);

    if (b.submit) {
      const m = { ...g, ...next };
      const missing = [];
      if (!s.finalDateId && s.dates.length && !m.rank.length && !m.noDates) missing.push("rank the dates you can make");
      if (!m.foodId && !m.writeIn && !m.noFood) missing.push("choose a dish");
      if (missing.length) throw new HttpError(400, `Please ${missing.join(" and ")}.`);
    }

    Object.assign(g, next);
    if (b.submit && !g.respondedAt) g.respondedAt = Date.now();
    await this.save();
    return json(this.guestView(g));
  }

  // ---------- admin ----------

  adminSecret() {
    const pw = this.env.ADMIN_PASSWORD;
    if (!pw) throw new HttpError(503, "ADMIN_PASSWORD isn't set on the Worker. Run: npx wrangler secret put ADMIN_PASSWORD");
    return pw;
  }

  async adminLogin(request, body) {
    const pw = this.adminSecret();
    const b = this.bucket(request, "admin", 8, 15 * 60e3);
    if (!timingSafeEqual(await sha256(String(body.password ?? "")), await sha256(pw))) {
      b.n++;
      throw new HttpError(401, "Wrong password.");
    }
    const exp = Date.now() + ADMIN_SESSION_MS;
    return json({ token: `${exp}.${await hmac(pw, `admin:${exp}`)}` });
  }

  async requireAdmin(request) {
    const pw = this.adminSecret();
    const [exp, sig] = bearer(request).split(".");
    if (!exp || !sig || !(Number(exp) > Date.now()) || !timingSafeEqual(sig, await hmac(pw, `admin:${exp}`))) {
      throw new HttpError(401, "Please sign in again.");
    }
  }

  // Instant runoff: each ballot counts for its highest-ranked date still in the
  // running, and the weakest date drops out until one has a majority. Ties go
  // to the date ranked higher overall, then to the earlier date.
  tally() {
    const s = this.s;
    const ballots = s.guests.map((g) => g.rank).filter((r) => r.length);
    const score = Object.fromEntries(s.dates.map((d) => [d.id, 0]));
    for (const r of ballots) r.forEach((id, i) => { score[id] += s.dates.length - i; });
    let alive = s.dates.map((d) => d.id);
    const rounds = [];
    while (alive.length && ballots.length) {
      const counts = Object.fromEntries(alive.map((id) => [id, 0]));
      let total = 0;
      for (const r of ballots) {
        const top = r.find((id) => id in counts);
        if (top) {
          counts[top]++;
          total++;
        }
      }
      const order = alive.slice().sort((a, b) => counts[b] - counts[a] || score[b] - score[a]);
      const round = { counts, total };
      rounds.push(round);
      if (alive.length === 1 || counts[order[0]] * 2 > total) return { ballots: ballots.length, winnerId: order[0], rounds };
      round.eliminated = order[order.length - 1];
      alive = alive.filter((id) => id !== round.eliminated);
    }
    return { ballots: ballots.length, winnerId: null, rounds };
  }

  // Everything the host may see. Deliberately has no path to s.draw.pairs.
  adminView() {
    const s = this.s;
    const foodName = (g) => {
      if (g.foodId) return s.foods.find((f) => f.id === g.foodId)?.name || "";
      if (g.writeIn) return `${g.writeIn} (own idea)`;
      return g.noFood ? "Nothing this time" : "";
    };
    return {
      party: s.party,
      categories: CATEGORIES,
      dates: s.dates.map((d) => ({
        ...d,
        ranks: s.guests
          .filter((g) => g.rank.includes(d.id))
          .map((g) => ({ name: g.name, pos: g.rank.indexOf(d.id) + 1 }))
          .sort((a, b) => a.pos - b.pos),
      })),
      poll: this.tally(),
      noDates: s.guests.filter((g) => g.noDates).map((g) => g.name),
      finalDateId: s.finalDateId,
      foods: s.foods.map((f) => ({ ...f, takenBy: s.guests.filter((g) => g.foodId === f.id).map((g) => g.name) })),
      guests: s.guests.map((g) => ({
        id: g.id, name: g.name, household: g.household, pin: g.pin,
        claimed: !!g.claimedAt, claimedAt: g.claimedAt, respondedAt: g.respondedAt,
        rank: g.rank, noDates: g.noDates, food: foodName(g), santa: g.santa, hints: g.hints,
        inDraw: !!s.draw?.pairs[g.id],
      })),
      draw: s.draw ? { at: s.draw.at, participants: Object.keys(s.draw.pairs).length } : null,
      minSantas: MIN_SANTAS,
    };
  }

  async admin(sub, method, b) {
    const s = this.s;
    const [section, id, action] = sub.split("/");
    const done = async () => {
      await this.save();
      return json(this.adminView());
    };

    if (section === "state" && method === "GET") return json(this.adminView());

    if (section === "party" && method === "PUT") {
      const code = normCode(b.code ?? s.party.code);
      if (code && (code.length < 4 || code.length > 40)) throw new HttpError(400, "The party code should be 4–40 characters.");
      let rsvpBy = "rsvpBy" in b ? b.rsvpBy : s.party.rsvpBy;
      if (rsvpBy === "" || rsvpBy == null) rsvpBy = null;
      else if (!(Number(rsvpBy) > 0 && Number(rsvpBy) < 4102444800000)) throw new HttpError(400, "That RSVP date doesn't look right.");
      else rsvpBy = Number(rsvpBy);
      s.party = {
        details: clip(b.details ?? s.party.details, 2000),
        budget: clip(b.budget ?? s.party.budget, 40),
        santaNote: clip(b.santaNote ?? s.party.santaNote, 500),
        code,
        rsvpBy,
      };
      return done();
    }

    if (section === "dates" && method === "PUT") {
      if (!Array.isArray(b.dates) || b.dates.length > 20) throw new HttpError(400, "Send up to 20 dates.");
      const dates = b.dates.map((d) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date || "")) throw new HttpError(400, "Dates look like 2026-12-19.");
        if (d.time && !/^\d{2}:\d{2}$/.test(d.time)) throw new HttpError(400, "Times look like 18:30.");
        const keep = s.dates.find((x) => x.id === d.id);
        return { id: keep ? keep.id : randomId(), date: d.date, time: d.time || "" };
      });
      dates.sort((a, b2) => (a.date + a.time).localeCompare(b2.date + b2.time));
      const ids = new Set(dates.map((d) => d.id));
      for (const g of s.guests) g.rank = g.rank.filter((k) => ids.has(k));
      if (!ids.has(s.finalDateId)) s.finalDateId = null;
      s.dates = dates;
      return done();
    }

    if (section === "final-date" && method === "PUT") {
      if (b.id && !s.dates.some((d) => d.id === b.id)) throw new HttpError(404, "No such date.");
      s.finalDateId = b.id || null;
      return done();
    }

    if (section === "foods" && method === "PUT") {
      if (!Array.isArray(b.foods) || b.foods.length > 100) throw new HttpError(400, "Send up to 100 dishes.");
      const foods = b.foods.map((f) => {
        const name = clip(f.name, 60);
        if (!name) throw new HttpError(400, "Every dish needs a name.");
        const keep = s.foods.find((x) => x.id === f.id);
        return {
          id: keep ? keep.id : randomId(),
          name,
          category: CATEGORIES.includes(f.category) ? f.category : "Other",
          slots: Math.min(20, Math.max(1, Math.floor(Number(f.slots) || 1))),
        };
      });
      const ids = new Set(foods.map((f) => f.id));
      for (const g of s.guests) if (g.foodId && !ids.has(g.foodId)) g.foodId = null;
      s.foods = foods;
      return done();
    }

    if (section === "guests") {
      if (!id && method === "POST") {
        const name = clip(b.name, 60);
        if (!name) throw new HttpError(400, "Guests need a name.");
        if (s.guests.length >= 100) throw new HttpError(400, "That's a lot of guests — the list tops out at 100.");
        if (s.guests.some((g) => g.name.toLowerCase() === name.toLowerCase())) {
          throw new HttpError(409, `${name} is already on the list. Add a last initial to tell them apart.`);
        }
        s.guests.push(newGuest(name, clip(b.household, 40), this.newPin()));
        return done();
      }
      const g = s.guests.find((x) => x.id === id);
      if (!g) throw new HttpError(404, "No such guest.");
      const drawn = !!s.draw && (s.draw.pairs[g.id] || Object.values(s.draw.pairs).includes(g.id));

      if (!action && method === "PUT") {
        const name = clip(b.name ?? g.name, 60);
        if (!name) throw new HttpError(400, "Guests need a name.");
        if (s.guests.some((x) => x !== g && x.name.toLowerCase() === name.toLowerCase())) {
          throw new HttpError(409, `${name} is already on the list.`);
        }
        g.name = name;
        g.household = clip(b.household ?? g.household, 40);
        return done();
      }
      if (action === "pin" && method === "POST") {
        g.pin = this.newPin();
        return done();
      }
      if (!action && method === "DELETE") {
        if (drawn) throw new HttpError(409, `${g.name} is part of the Secret Santa draw. Cancel the draw first.`);
        s.guests = s.guests.filter((x) => x !== g);
        return done();
      }
    }

    if (section === "draw" && !id && method === "POST") {
      if (s.draw) throw new HttpError(409, "Names are already drawn.");
      const players = s.guests.filter((g) => g.respondedAt && g.santa);
      if (players.length < MIN_SANTAS) {
        throw new HttpError(400, `Only ${players.length} people have responded and joined Secret Santa (minimum ${MIN_SANTAS}).`);
      }
      s.draw = { at: Date.now(), pairs: makePairs(players) };
      return done();
    }

    if (section === "draw" && id === "cancel" && method === "POST") {
      s.draw = null;
      return done();
    }

    // Adds guests and dishes from an export file. Never removes anything, and
    // skips names that are already listed, so importing twice is harmless.
    if (section === "import" && method === "POST") {
      const out = { guests: 0, foods: 0, skipped: 0 };
      for (const x of Array.isArray(b.guests) ? b.guests.slice(0, 100) : []) {
        const name = clip(x?.name, 60);
        if (!name) continue;
        if (s.guests.length >= 100 || s.guests.some((g) => g.name.toLowerCase() === name.toLowerCase())) {
          out.skipped++;
          continue;
        }
        // Keep the PIN from the file when it's still free, in case it was already texted out.
        const pin = /^\d{6}$/.test(x.pin) && !s.guests.some((g) => g.pin === x.pin) ? x.pin : this.newPin();
        s.guests.push(newGuest(name, clip(x.household, 40), pin));
        out.guests++;
      }
      for (const x of Array.isArray(b.foods) ? b.foods.slice(0, 100) : []) {
        const name = clip(x?.name, 60);
        if (!name) continue;
        if (s.foods.length >= 100 || s.foods.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
          out.skipped++;
          continue;
        }
        s.foods.push({
          id: randomId(),
          name,
          category: CATEGORIES.includes(x.category) ? x.category : "Other",
          slots: Math.min(20, Math.max(1, Math.floor(Number(x.slots) || 1))),
        });
        out.foods++;
      }
      if (!out.guests && !out.foods && !out.skipped) throw new HttpError(400, "That file has no guests or dishes.");
      await this.save();
      return json({ ...this.adminView(), imported: out });
    }

    if (section === "reset" && method === "POST") {
      if (b.confirm !== "RESET") throw new HttpError(400, 'Type RESET to confirm.');
      this.s = freshState();
      return done();
    }

    throw new HttpError(404, "Not found.");
  }
}
