import { DurableObject } from "cloudflare:workers";
import { providerStatus, sendMessage } from "./notify.js";
import {
  HttpError, json, readJson, bearer, clip, normCode, firstName,
  randomToken, randomId, sha256, hmac, timingSafeEqual, shuffle, parseContact, formatDate,
} from "./util.js";

const VOTES = ["yes", "maybe", "no"];
const CATEGORIES = ["Appetizer", "Main", "Side", "Dessert", "Drinks", "Other"];
const MIN_SANTAS = 3;
const MAX_SEND_ATTEMPTS = 3;
const ADMIN_SESSION_MS = 7 * 24 * 3600e3;

function freshState() {
  return {
    party: { details: "", budget: "", santaNote: "", code: "" },
    dates: [],       // { id, date: "YYYY-MM-DD", time: "HH:MM" | "" }
    finalDateId: null,
    foods: [],       // { id, name, category, slots }
    guests: [],      // see newGuest()
    draw: null,      // { at, pairs: { giverId: receiverId } } — never leaves this object except in a guest's own view
    drawError: null,
  };
}

function newGuest(name, household) {
  return {
    id: randomId(), name, household,
    tokenHash: null, claimedAt: null, respondedAt: null,
    votes: {}, foodId: null, writeIn: "", noFood: false,
    santa: true, contact: null, hints: "",
    notify: null,    // { status: pending|sending|sent|dry-run|failed, at, attempts, error }
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
    if (!this.s) this.s = (await this.ctx.storage.get("state")) || freshState();
    return this.s;
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

    if (path === "/api/enter" && method === "POST") return this.enter(request, body);
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
      guests: this.s.guests.map((g) => ({ id: g.id, name: g.name, claimed: !!g.tokenHash })),
    });
  }

  async claim(request, body) {
    this.checkCode(request, body.code);
    const g = this.s.guests.find((x) => x.id === body.guestId);
    if (!g) throw new HttpError(404, "That name is no longer on the guest list.");
    if (g.tokenHash) {
      throw new HttpError(409, `${g.name} has already been claimed. Use your private link on the other device, or contact the host.`);
    }
    const token = randomToken();
    g.tokenHash = await sha256(token);
    g.claimedAt = Date.now();
    await this.save();
    return json({ token });
  }

  async guestFromAuth(request) {
    const token = bearer(request);
    if (token) {
      const hash = await sha256(token);
      const g = this.s.guests.find((x) => x.tokenHash === hash);
      if (g) return g;
    }
    throw new HttpError(401, "This device is no longer signed in. Enter the party code again.");
  }

  // Contact types a guest may give. Until delivery is set up, either is accepted.
  channels() {
    const p = providerStatus(this.env);
    return p.email || p.sms ? { email: !!p.email, sms: !!p.sms } : { email: true, sms: true };
  }

  guestView(g) {
    const s = this.s;
    const receiverId = s.draw?.pairs[g.id];
    const receiver = receiverId && s.guests.find((x) => x.id === receiverId);
    return {
      me: {
        id: g.id, name: g.name, votes: g.votes, foodId: g.foodId, writeIn: g.writeIn, noFood: g.noFood,
        santa: g.santa, contact: g.contact, hints: g.hints, respondedAt: g.respondedAt,
      },
      party: { details: s.party.details, budget: s.party.budget, santaNote: s.party.santaNote },
      dates: s.dates.map((d) => ({
        ...d,
        yes: s.guests.filter((x) => x.votes[d.id] === "yes").length,
        maybe: s.guests.filter((x) => x.votes[d.id] === "maybe").length,
      })),
      finalDate: s.dates.find((d) => d.id === s.finalDateId) || null,
      channels: this.channels(),
      categories: CATEGORIES,
      foods: s.foods.map((f) => {
        const takers = s.guests.filter((x) => x.foodId === f.id);
        return { ...f, takenBy: takers.map((x) => firstName(x.name)), left: Math.max(0, f.slots - takers.length) };
      }),
      extras: s.guests
        .filter((x) => x.id !== g.id && x.writeIn)
        .map((x) => ({ who: firstName(x.name), dish: x.writeIn })),
      progress: { invited: s.guests.length, responded: s.guests.filter((x) => x.respondedAt).length },
      santa: {
        drawn: !!s.draw,
        inDraw: !!receiver,
        match: receiver ? { name: receiver.name, hints: receiver.hints } : null,
        notify: receiver ? g.notify?.status || null : null,
      },
    };
  }

  async updateGuest(g, b) {
    const s = this.s;
    const next = {};

    if ("votes" in b) {
      if (!b.votes || typeof b.votes !== "object") throw new HttpError(400, "Malformed votes.");
      next.votes = {};
      for (const d of s.dates) {
        const v = b.votes[d.id] ?? g.votes[d.id];
        if (v === undefined) continue;
        if (!VOTES.includes(v)) throw new HttpError(400, "Votes are yes, maybe or no.");
        next.votes[d.id] = v;
      }
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
    if ("contact" in b) {
      next.contact = parseContact(b.contact);
      if (!this.channels()[next.contact.type]) {
        throw new HttpError(400, next.contact.type === "email"
          ? "Please use a mobile number — Secret Santa matches go out by text."
          : "Please use an email address — Secret Santa matches go out by email.");
      }
    }
    if ("hints" in b) next.hints = clip(b.hints, 600);

    if (b.submit) {
      const m = { ...g, ...next };
      const missing = [];
      if (!s.finalDateId && s.dates.some((d) => !m.votes[d.id])) missing.push("answer every date");
      if (!m.foodId && !m.writeIn && !m.noFood) missing.push("choose a dish");
      if (!m.contact) missing.push("add your contact");
      if (missing.length) throw new HttpError(400, `Please ${missing.join(", ")}.`);
    }

    const contactChanged = next.contact && next.contact.value !== g.contact?.value;
    Object.assign(g, next);
    if (b.submit && !g.respondedAt) g.respondedAt = Date.now();

    // A new address after the draw gets the match re-sent there.
    if (contactChanged && s.draw?.pairs[g.id]) {
      g.notify = { status: "pending", attempts: 0 };
      await this.kick();
    }
    if (b.submit) await this.autoDraw();
    await this.save();
    return json(this.guestView(g));
  }

  // ---------- the draw ----------

  async autoDraw() {
    const s = this.s;
    if (s.draw || !s.guests.length || s.guests.some((g) => !g.respondedAt)) return;
    const players = s.guests.filter((g) => g.santa);
    if (players.length < MIN_SANTAS) {
      s.drawError = `All guests have responded, but only ${players.length} are in Secret Santa (minimum ${MIN_SANTAS}).`;
      return;
    }
    try {
      await this.draw(players);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      s.drawError = err.message;
    }
  }

  async draw(players) {
    const s = this.s;
    const pairs = makePairs(players);
    s.draw = { at: Date.now(), pairs };
    s.drawError = null;
    for (const g of s.guests) g.notify = pairs[g.id] ? { status: "pending", attempts: 0 } : null;
    await this.kick();
  }

  async kick(delay = 250) {
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  matchMessage(giver, receiver) {
    const p = this.s.party;
    const date = this.s.dates.find((d) => d.id === this.s.finalDateId);
    const lines = [
      "Christmas Party Secret Santa",
      `${firstName(giver.name)}, you're buying a gift for ${receiver.name}.`,
    ];
    if (receiver.hints) lines.push(`Gift ideas: ${receiver.hints}`);
    if (p.budget) lines.push(`Budget: ${p.budget}`);
    if (date) lines.push(`Party: ${formatDate(date)}`);
    if (p.santaNote) lines.push(p.santaNote);
    if (this.env.SITE_URL) lines.push(`Details: ${this.env.SITE_URL}`);
    return { subject: "Christmas Party Secret Santa", text: lines.join("\n") };
  }

  // Sends every pending match. Network calls happen outside the request queue
  // so guests aren't held up by a slow mail provider.
  async alarm() {
    const jobs = await this.serial(async () => {
      const s = await this.load();
      if (!s.draw) return [];
      const now = Date.now();
      const out = [];
      for (const g of s.guests) {
        const n = g.notify;
        if (!n) continue;
        // A "sending" left behind by an eviction mid-send goes round again.
        if (!(n.status === "pending" || (n.status === "sending" && now - n.at > 5 * 60e3))) continue;
        const receiver = s.guests.find((x) => x.id === s.draw.pairs[g.id]);
        if (!g.contact || !receiver) {
          g.notify = { status: "failed", at: now, attempts: n.attempts, error: g.contact ? "Match is missing." : "No email or phone on file." };
          continue;
        }
        g.notify = { ...n, status: "sending", at: now };
        out.push({ id: g.id, drawAt: s.draw.at, contact: g.contact, msg: this.matchMessage(g, receiver) });
      }
      await this.save();
      return out;
    });
    if (!jobs.length) return;

    const results = await Promise.all(jobs.map((j) =>
      sendMessage(this.env, j.contact, j.msg).then(
        (r) => ({ ...j, ...r }),
        (e) => ({ ...j, ok: false, error: String(e?.message || e) }),
      )));

    await this.serial(async () => {
      const s = this.s;
      let retry = false;
      for (const r of results) {
        const g = s.guests.find((x) => x.id === r.id);
        // Skip anything the draw was cancelled, redone or re-queued under us.
        if (!g || s.draw?.at !== r.drawAt || g.notify?.status !== "sending") continue;
        const attempts = (g.notify.attempts || 0) + 1;
        if (r.ok) g.notify = { status: r.status, at: Date.now(), attempts };
        else if (r.permanent || attempts >= MAX_SEND_ATTEMPTS) g.notify = { status: "failed", at: Date.now(), attempts, error: r.error };
        else {
          g.notify = { status: "pending", at: Date.now(), attempts, error: r.error };
          retry = true;
        }
      }
      await this.save();
      if (retry) await this.kick(60e3);
    });
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
        votes: Object.fromEntries(VOTES.map((v) => [v, s.guests.filter((g) => g.votes[d.id] === v).map((g) => g.name)])),
      })),
      finalDateId: s.finalDateId,
      foods: s.foods.map((f) => ({ ...f, takenBy: s.guests.filter((g) => g.foodId === f.id).map((g) => g.name) })),
      guests: s.guests.map((g) => ({
        id: g.id, name: g.name, household: g.household,
        claimed: !!g.tokenHash, claimedAt: g.claimedAt, respondedAt: g.respondedAt,
        votes: g.votes, food: foodName(g), santa: g.santa, contact: g.contact, hints: g.hints,
        inDraw: !!s.draw?.pairs[g.id], notify: g.notify,
      })),
      draw: s.draw ? { at: s.draw.at, participants: Object.keys(s.draw.pairs).length } : null,
      drawError: s.drawError,
      providers: providerStatus(this.env),
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
      s.party = {
        details: clip(b.details ?? s.party.details, 2000),
        budget: clip(b.budget ?? s.party.budget, 40),
        santaNote: clip(b.santaNote ?? s.party.santaNote, 500),
        code,
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
      for (const g of s.guests) for (const k of Object.keys(g.votes)) if (!ids.has(k)) delete g.votes[k];
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
        s.guests.push(newGuest(name, clip(b.household, 40)));
        s.drawError = null;
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
      if (!action && method === "DELETE") {
        if (drawn) throw new HttpError(409, `${g.name} is part of the Secret Santa draw. Cancel the draw first.`);
        s.guests = s.guests.filter((x) => x !== g);
        s.drawError = null;
        await this.autoDraw();
        return done();
      }
      if (action === "release" && method === "POST") {
        // After the draw, a released spot could be claimed by someone else, who
        // would then see this guest's match. Resend covers a lost link instead.
        if (drawn) throw new HttpError(409, `Names are drawn, so ${g.name}'s spot can't be released — use Resend to send their match again.`);
        g.tokenHash = null;
        g.claimedAt = null;
        return done();
      }
    }

    if (section === "draw" && !id && method === "POST") {
      if (s.draw) throw new HttpError(409, "Names are already drawn.");
      const players = s.guests.filter((g) => g.respondedAt && g.santa);
      if (players.length < MIN_SANTAS) {
        throw new HttpError(400, `Only ${players.length} people have replied and joined Secret Santa — the draw needs at least ${MIN_SANTAS}.`);
      }
      await this.draw(players);
      return done();
    }

    if (section === "draw" && id === "cancel" && method === "POST") {
      s.draw = null;
      s.drawError = null;
      for (const g of s.guests) g.notify = null;
      return done();
    }

    if (section === "notify" && id === "resend" && method === "POST") {
      if (!s.draw) throw new HttpError(409, "Names haven't been drawn yet.");
      const targets = s.guests.filter((g) => s.draw.pairs[g.id] && (b.guestId ? g.id === b.guestId : g.notify?.status === "failed"));
      if (!targets.length) throw new HttpError(400, "Nothing to resend.");
      for (const g of targets) g.notify = { status: "pending", attempts: 0 };
      await this.kick();
      return done();
    }

    if (section === "notify" && id === "test" && method === "POST") {
      const contact = parseContact(b.contact);
      const r = await sendMessage(this.env, contact, {
        subject: "Christmas Party test message",
        text: "Christmas Party test message. Secret Santa messages can reach you here.",
      });
      return json({ ok: r.ok, status: r.status, error: r.error || null, to: contact.value });
    }

    if (section === "reset" && method === "POST") {
      if (b.confirm !== "RESET") throw new HttpError(400, 'Type RESET to confirm.');
      this.s = freshState();
      await this.ctx.storage.deleteAlarm();
      return done();
    }

    throw new HttpError(404, "Not found.");
  }
}
