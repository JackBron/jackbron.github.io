(() => {
  const app = document.getElementById("app");
  const hero = document.getElementById("hero-body");
  const TOKEN_KEY = "xmas.token";

  const tokenStore = {
    get() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
    set(v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch {} },
  };

  const STEPS = [["dates", "Date"], ["food", "Potluck"], ["santa", "Secret Santa"], ["review", "Review"]];
  let token = null;
  let me = null;          // last GET /api/me
  let view = "loading";
  let entry = null;       // { code, party, guests, pick } while choosing a name
  let revealed = false;
  let busy = false;
  let pollTimer = null;
  let inviteCode = "";    // from an invite link, kept in case this device's old sign-in is stale

  // ---------- boot ----------

  function boot() {
    const h = new URLSearchParams(location.hash.slice(1));
    inviteCode = h.get("code") || "";
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    token = tokenStore.get();
    if (!Api.configured) return show("unconfigured");
    if (token) loadMe(true);
    else showCode(inviteCode);
  }

  async function loadMe(first) {
    try {
      me = await Api.call("GET", "/api/me", null, token);
    } catch (e) {
      if (e.status === 401) {
        tokenStore.set(null);
        token = null;
        return showCode(inviteCode, inviteCode ? "" : e.message);
      }
      if (first) return show("error", e.message);
      return;
    }
    renderHero();
    if (first) show(me.me.respondedAt ? "home" : firstOpenStep());
    else live();
  }

  function firstOpenStep() {
    const m = me.me;
    if (!me.finalDate && me.dates.some((d) => !m.votes[d.id])) return "dates";
    if (!m.foodId && !m.writeIn && !m.noFood) return "food";
    return "santa";
  }

  function show(v, arg) {
    view = v;
    window.scrollTo({ top: 0 });
    render(arg);
    clearInterval(pollTimer);
    if (["dates", "food", "home"].includes(v)) pollTimer = setInterval(() => !document.hidden && !busy && loadMe(false), 10000);
  }

  // Poll refresh: redraw only the parts that change under the guest, so typing
  // and focus survive.
  function live() {
    if (view === "food") {
      document.getElementById("food-live").innerHTML = foodLive();
    } else if (view === "dates") {
      for (const d of me.dates) {
        const el = document.getElementById(`tally-${d.id}`);
        if (el) el.textContent = tally(d);
      }
    } else if (view === "home") {
      render();
    }
  }

  // ---------- hero ----------

  function renderHero() {
    if (!me) return;
    const when = me.finalDate
      ? `<span class="when">${ICON_STAR} ${esc(fmtDate(me.finalDate))}</span>`
      : `<span class="when">Date not set yet</span>`;
    hero.innerHTML = `<h1>Christmas Party</h1>${when}`;
  }

  // ---------- render ----------

  function render(arg) {
    const r = {
      loading: () => `<div class="spinner" role="status" aria-label="Loading"></div>`,
      unconfigured: () => `<section class="card"><h2>Not configured</h2><p class="muted">Set <code>API_DEFAULT</code> in <code>christmas/js/api.js</code> to the Worker URL.</p></section>`,
      error: () => `<section class="card"><h2>Error</h2><p class="muted">${esc(arg)}</p><button class="btn primary" data-act="retry">Try again</button></section>`,
      code: () => viewCode(arg),
      who: viewWho,
      dates: viewDates,
      food: viewFood,
      santa: viewSanta,
      review: viewReview,
      home: viewHome,
    }[view];
    app.innerHTML = r();
    if (view === "code") app.querySelector("#code")?.focus();
  }

  function stepper() {
    const i = STEPS.findIndex(([k]) => k === view);
    const done = me.me.respondedAt;
    return `<ol class="steps">${STEPS.map(([k, label], j) =>
      `<li class="${j === i ? "on" : j < i || done ? "done" : ""}"><button data-go="${k}" ${j === i ? 'aria-current="step"' : ""}>${label}</button></li>`).join("")}</ol>`;
  }

  function nav(back, nextAct, nextLabel = "Next") {
    return `<div class="nav">
      ${back ? `<button class="btn ghost" data-go="${back}">Back</button>` : ""}
      <button class="btn primary" data-act="${nextAct}">${nextLabel}</button>
    </div>`;
  }

  function viewCode(msg) {
    return `<section class="card">
      <h2>Party code</h2>
      <form id="code-form" autocomplete="off">
        <input id="code" class="code-input" type="text" autocapitalize="characters" spellcheck="false" aria-label="Party code" value="${esc(entry?.code || "")}" required>
        <p class="err" id="code-err" role="alert">${esc(msg || "")}</p>
        <button class="btn primary block" type="submit">Continue</button>
      </form>
    </section>`;
  }

  function viewWho() {
    const pick = entry.guests.find((g) => g.id === entry.pick);
    return `<section class="card">
      <h2>Select your name</h2>
      <ul class="names">${entry.guests.map((g) => `
        <li><button data-pick="${g.id}" aria-pressed="${g.id === entry.pick}">${esc(g.name)}</button></li>`).join("")}
      </ul>
      <p class="hint" style="margin-top:1rem">Name missing? Contact the host.</p>
      <p class="err" id="who-err" role="alert"></p>
      <div class="nav">
        <button class="btn ghost" data-act="to-code">Back</button>
        <button class="btn primary" data-act="claim" ${pick ? "" : "disabled"}>Continue</button>
      </div>
    </section>`;
  }

  const tally = (d) => [d.yes && `${d.yes} yes`, d.maybe && `${d.maybe} maybe`].filter(Boolean).join(" · ") || "No votes yet";

  function viewDates() {
    const m = me.me;
    const body = me.dates.length
      ? `<ul class="dates">${me.dates.map((d) => `
          <li class="date-row${me.finalDate?.id === d.id ? " final" : ""}" id="row-${d.id}">
            <div class="date-label">
              <b>${esc(fmtDay(d))}</b>${d.time ? `<span>${esc(fmtTime(d))}</span>` : ""}
              <small id="tally-${d.id}">${tally(d)}</small>
            </div>
            <div class="seg" role="radiogroup" aria-label="${esc(fmtDay(d))}">
              ${["yes", "maybe", "no"].map((v) => `
                <label><input type="radio" name="v-${d.id}" value="${v}" data-vote="${d.id}" ${m.votes[d.id] === v ? "checked" : ""}><span>${v[0].toUpperCase() + v.slice(1)}</span></label>`).join("")}
            </div>
          </li>`).join("")}</ul>`
      : `<p class="note">No dates have been added yet.</p>`;
    return `${stepper()}<section class="card">
      <h2>Dates</h2>
      <p class="lead">Mark whether you can attend on each date.</p>
      ${me.finalDate ? `<p class="note">Party date: <b>${esc(fmtDate(me.finalDate))}</b></p>` : ""}
      ${body}
      <p class="err" id="dates-err" role="alert"></p>
      ${nav(null, "dates-next")}
    </section>`;
  }

  function foodLive() {
    const m = me.me;
    const mine = me.foods.find((f) => f.id === m.foodId);
    const chosen = mine ? mine.name : m.writeIn;
    const bar = chosen
      ? `<div class="mine-bar"><span>Bringing: <b>${esc(chosen)}</b></span><button class="btn link" data-food-clear>Change</button></div>`
      : m.noFood
        ? `<div class="mine-bar"><span>Not bringing a dish</span><button class="btn link" data-food-clear>Change</button></div>`
        : `<div class="mine-bar empty">No dish selected.</div>`;
    const groups = me.categories
      .map((c) => [c, me.foods.filter((f) => f.category === c)])
      .filter(([, list]) => list.length);
    const list = groups.map(([c, list]) => `
      <div class="food-group"><h3>${esc(c)}</h3><ul class="foods">${list.map((f) => {
        const isMine = f.id === m.foodId;
        const full = !isMine && f.left === 0;
        const others = f.takenBy.filter((n) => n !== m.name.split(/\s+/)[0]);
        const meta = isMine ? esc(["you", ...others].join(", "))
          : full ? esc(f.takenBy.join(", "))
          : f.slots > 1 ? `${f.left} of ${f.slots} open` : "open";
        return `<li><button class="dish${isMine ? " mine" : ""}" data-dish="${f.id}" ${full ? "disabled" : ""} aria-pressed="${isMine}">
          <span class="tick" aria-hidden="true"></span><span class="dish-name">${esc(f.name)}</span><span class="dish-meta">${meta}</span>
        </button></li>`;
      }).join("")}</ul></div>`).join("");
    const extras = me.extras.length
      ? `<div class="food-group"><h3>Other dishes</h3><ul class="extras">${me.extras.map((x) => `<li>${esc(x.who)} — ${esc(x.dish)}</li>`).join("")}</ul></div>` : "";
    return bar + (list || `<p class="note">No dishes have been added yet.</p>`) + extras;
  }

  function viewFood() {
    return `${stepper()}<section class="card">
      <h2>Potluck</h2>
      <p class="lead">Choose a dish to bring. Claimed dishes are greyed out.</p>
      <div id="food-live">${foodLive()}</div>
      <div class="alt">
        <label class="field" style="margin:0"><span>Other dish</span>
          <div class="row"><input type="text" id="write-in" maxlength="80" value="${esc(me.me.writeIn)}"><button class="btn ghost" data-act="write-in">Save</button></div>
        </label>
        <button class="btn link" data-act="no-food" style="justify-self:start">Not bringing a dish</button>
      </div>
      <p class="err" id="food-err" role="alert"></p>
      ${nav("dates", "food-next")}
    </section>`;
  }

  function viewSanta() {
    const m = me.me;
    const p = me.party;
    const locked = me.santa.drawn;
    return `${stepper()}<section class="card">
      <h2>Secret Santa</h2>
      <p class="lead">Names are drawn after everyone has RSVPed. Your match will be shown on this page.${p.budget ? ` Budget: <b>${esc(p.budget)}</b>.` : ""}</p>
      ${p.santaNote ? `<p class="note">${esc(p.santaNote)}</p>` : ""}
      <label class="switch"><input type="checkbox" id="santa-in" ${m.santa ? "checked" : ""} ${locked ? "disabled" : ""}><span class="track" aria-hidden="true"></span>Participate in Secret Santa</label>
      ${locked ? `<p class="hint">Names have already been drawn.</p>` : ""}
      <label class="field" id="hints-field" ${m.santa ? "" : "hidden"}><span>Gift ideas <span class="muted small">(optional)</span></span>
        <textarea id="hints" maxlength="600">${esc(m.hints)}</textarea>
        <span class="hint">Shown to the person who draws your name.</span>
      </label>
      <p class="err" id="santa-err" role="alert"></p>
      ${nav("food", "santa-next")}
    </section>`;
  }

  function foodLabel() {
    const m = me.me;
    const f = me.foods.find((x) => x.id === m.foodId);
    return f ? f.name : m.writeIn || (m.noFood ? "Nothing" : "");
  }

  function voteSummary() {
    if (!me.dates.length) return "No dates yet";
    const yes = me.dates.filter((d) => me.me.votes[d.id] === "yes").map((d) => fmtDay(d, { month: "short", day: "numeric" }));
    const answered = me.dates.filter((d) => me.me.votes[d.id]).length;
    if (answered < me.dates.length) return `${answered} of ${me.dates.length} answered`;
    return yes.length ? `Available ${yes.join(", ")}` : "Not available";
  }

  function viewReview() {
    const m = me.me;
    const row = (k, v, go) => `<li><span class="k">${k}</span><span class="v">${v ? esc(v) : '<span class="muted">—</span>'}</span><button class="btn link" data-go="${go}">Edit</button></li>`;
    return `${stepper()}<section class="card">
      <h2>Review</h2>
      <ul class="summary">
        ${row("Dates", voteSummary(), "dates")}
        ${row("Bringing", foodLabel(), "food")}
        ${row("Secret Santa", m.santa ? "Yes" : "No", "santa")}
      </ul>
      <p class="err" id="review-err" role="alert"></p>
      ${nav("santa", "submit", m.respondedAt ? "Save" : "Submit")}
    </section>`;
  }

  function santaCard() {
    const s = me.santa;
    const m = me.me;
    if (!m.santa && !s.inDraw) return `<section class="card"><h3>Secret Santa</h3><p class="muted">Not participating.${s.drawn ? "" : ` <button class="btn link" data-go="santa">Change</button>`}</p></section>`;
    if (!s.drawn) {
      return `<section class="card">
        <h3>Secret Santa</h3>
        <p class="muted">Names haven't been drawn yet. Your match will appear here once they are. <button class="btn link" data-go="santa">Change</button></p>
      </section>`;
    }
    if (!s.inDraw) return `<section class="card"><h3>Secret Santa</h3><p class="muted">Names were drawn before you responded, so you weren't included. Contact the host.</p></section>`;
    return `<section class="card">
      <h3>Secret Santa</h3>
      ${revealed
        ? `<div class="match"><div class="for">You're buying for</div><div class="who">${esc(s.match.name)}</div>
            ${s.match.hints ? `<blockquote>${esc(s.match.hints)}</blockquote>` : `<p class="muted small">No gift ideas listed.</p>`}
            ${me.party.budget ? `<p class="small muted">Budget: ${esc(me.party.budget)}</p>` : ""}
            <button class="btn link" data-act="hide">Hide</button></div>`
        : `<button class="reveal" data-act="reveal"><span>Show my match</span></button>`}
    </section>`;
  }

  function viewHome() {
    const m = me.me;
    const p = me.party;
    return `
      <section class="card">
        <h2>Your RSVP</h2>
        <ul class="summary">
          <li><span class="k">Date</span><span class="v">${me.finalDate ? esc(fmtDate(me.finalDate)) : `Not set · ${esc(voteSummary())}`}</span><button class="btn link" data-go="dates">${me.finalDate ? "Dates" : "Edit"}</button></li>
          <li><span class="k">Bringing</span><span class="v">${esc(foodLabel()) || '<span class="muted">—</span>'}</span><button class="btn link" data-go="food">Change</button></li>
        </ul>
        ${p.details ? `<p class="muted" style="white-space:pre-wrap;margin:1rem 0 0">${esc(p.details)}</p>` : ""}
      </section>
      ${santaCard()}
      <p class="muted small" style="text-align:center"><button class="btn link" data-act="sign-out">Not ${esc(m.name)}? Sign out</button></p>`;
  }

  // ---------- actions ----------

  async function save(patch, errId) {
    busy = true;
    try {
      me = await Api.call("PUT", "/api/me", patch, token);
      renderHero();
      return true;
    } catch (e) {
      if (e.status === 401) {
        tokenStore.set(null);
        token = null;
        showCode("", e.message);
        return false;
      }
      const el = errId && document.getElementById(errId);
      if (el) el.textContent = e.message;
      else toast(e.message, true);
      if (e.status === 409) loadMe(false);
      return false;
    } finally {
      busy = false;
    }
  }

  function showCode(code, msg) {
    entry = { code, party: null, guests: [], pick: null };
    show("code", msg);
  }

  async function submitCode(code) {
    const err = document.getElementById("code-err");
    err.textContent = "";
    try {
      const r = await Api.call("POST", "/api/enter", { code });
      entry = { code, party: r.party, guests: r.guests, pick: null };
      show("who");
    } catch (e) {
      err.textContent = e.message;
    }
  }

  async function claim() {
    const err = document.getElementById("who-err");
    try {
      const r = await Api.call("POST", "/api/claim", { code: entry.code, guestId: entry.pick });
      token = r.token;
      tokenStore.set(token);
      entry = null;
      show("loading");
      await loadMe(true);
    } catch (e) {
      err.textContent = e.message;
    }
  }

  async function santaNext(then) {
    const patch = { hints: document.getElementById("hints").value };
    if (!me.santa.drawn) patch.santa = document.getElementById("santa-in").checked;
    if (await save(patch, "santa-err")) show(then);
  }

  app.addEventListener("submit", (e) => {
    if (e.target.id === "code-form") {
      e.preventDefault();
      submitCode(document.getElementById("code").value);
    }
  });

  app.addEventListener("change", async (e) => {
    const t = e.target;
    if (t.dataset.vote) {
      document.getElementById(`row-${t.dataset.vote}`)?.classList.remove("missing");
      if (await save({ votes: { [t.dataset.vote]: t.value } }, "dates-err")) live();
    } else if (t.id === "santa-in") {
      document.getElementById("hints-field").hidden = !t.checked;
    }
  });

  app.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;

    if (b.dataset.go) {
      // Leaving the Secret Santa form by the stepper or Back keeps what was typed.
      if (view === "santa" && b.dataset.go !== "santa") return santaNext(b.dataset.go);
      return show(b.dataset.go);
    }
    if (b.dataset.pick) {
      entry.pick = b.dataset.pick;
      return render();
    }
    if (b.dataset.dish) {
      const mine = b.dataset.dish === me.me.foodId;
      if (await save({ food: mine ? null : { dish: b.dataset.dish } }, "food-err")) live();
      return;
    }
    if ("foodClear" in b.dataset) {
      if (await save({ food: null }, "food-err")) view === "food" ? live() : render();
      return;
    }

    switch (b.dataset.act) {
      case "retry": show("loading"); return loadMe(true);
      case "to-code": return showCode(entry?.code || "");
      case "claim": b.disabled = true; await claim(); b.disabled = false; return;
      case "dates-next": {
        const missing = me.finalDate ? [] : me.dates.filter((d) => !me.me.votes[d.id]);
        if (missing.length) {
          missing.forEach((d) => document.getElementById(`row-${d.id}`)?.classList.add("missing"));
          document.getElementById("dates-err").textContent = "Answer every date to continue.";
          return;
        }
        return show(me.me.respondedAt ? "home" : "food");
      }
      case "write-in": {
        const v = document.getElementById("write-in").value.trim();
        if (!v) return (document.getElementById("food-err").textContent = "Enter a dish first.");
        if (await save({ food: { other: v } }, "food-err")) live();
        return;
      }
      case "no-food":
        if (await save({ food: { none: true } }, "food-err")) live();
        return;
      case "food-next": {
        const m = me.me;
        if (!m.foodId && !m.writeIn && !m.noFood) {
          document.getElementById("food-err").textContent = "Choose a dish, or select “Not bringing a dish”.";
          return;
        }
        return show(m.respondedAt ? "home" : "santa");
      }
      case "santa-next": return santaNext(me.me.respondedAt ? "home" : "review");
      case "submit":
        b.disabled = true;
        if (await save({ submit: true }, "review-err")) {
          show("home");
          toast("RSVP submitted");
        } else b.disabled = false;
        return;
      case "reveal": revealed = true; return render();
      case "hide": revealed = false; return render();
      case "sign-out":
        tokenStore.set(null);
        token = me = null;
        revealed = false;
        hero.innerHTML = "<h1>Christmas Party</h1>";
        return showCode(inviteCode);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && token && me && !busy) loadMe(false);
  });

  boot();
})();
