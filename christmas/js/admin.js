(() => {
  const app = document.getElementById("app");
  const KEY = "xmas.admin";
  const TABS = [["overview", "Overview"], ["dates", "Dates"], ["food", "Potluck"], ["guests", "Guests"], ["santa", "Secret Santa"], ["settings", "Settings"]];

  let token = null;
  try { token = localStorage.getItem(KEY); } catch {}
  let S = null;            // admin state
  let tab = "overview";
  try { tab = sessionStorage.getItem("xmas.admin.tab") || tab; } catch {}
  let editing = null;      // guest id being edited inline

  const guestLink = () => new URL("../", location.href).href;
  const inviteLink = () => `${guestLink()}#code=${encodeURIComponent(S.party.code)}`;
  const santaLink = () => new URL("../santa/", location.href).href;
  const pinMessage = (g) => `Secret Santa is live! Go to ${santaLink()} and enter your PIN: ${g.pin}`;

  async function call(method, path, body) {
    try {
      const r = await Api.call(method, `/api/admin/${path}`, body, token);
      if (r && r.party) S = r;
      return r;
    } catch (e) {
      if (e.status === 401) {
        signOut(e.message);
        throw e;
      }
      toast(e.message, true);
      throw e;
    }
  }

  function signOut(msg) {
    token = null;
    try { localStorage.removeItem(KEY); } catch {}
    document.getElementById("logout").hidden = true;
    renderLogin(msg);
  }

  // ---------- login ----------

  function renderLogin(msg) {
    app.innerHTML = Api.configured
      ? `<section class="card" style="max-width:26rem;margin:0 auto">
          <h2>Admin sign-in</h2>
          <form id="login">
            <input type="password" id="pw" autocomplete="current-password" aria-label="Password" required>
            <p class="err" role="alert">${esc(msg || "")}</p>
            <button class="btn primary block">Sign in</button>
          </form>
        </section>`
      : `<section class="card"><h2>Not connected</h2><p class="muted">Set <code>API_DEFAULT</code> in <code>christmas/js/api.js</code> to the Worker URL.</p></section>`;
    app.querySelector("#pw")?.focus();
  }

  async function login(pw) {
    const err = app.querySelector(".err");
    try {
      token = (await Api.call("POST", "/api/admin/login", { password: pw })).token;
      try { localStorage.setItem(KEY, token); } catch {}
      await load();
    } catch (e) {
      err.textContent = e.message;
    }
  }

  async function load() {
    try {
      await call("GET", "state");
    } catch {
      return;
    }
    document.getElementById("logout").hidden = false;
    render();
  }

  // ---------- render ----------

  function render() {
    const html = { overview, dates, food, guests, santa, settings }[tab]();
    app.innerHTML = `<nav class="tabs" role="tablist">${TABS.map(([k, l]) =>
      `<button role="tab" data-tab="${k}" aria-selected="${k === tab}">${l}</button>`).join("")}</nav>${html}`;
    const on = app.querySelector(".tabs [aria-selected=true]");
    if (on) on.parentNode.scrollLeft = on.offsetLeft - (on.parentNode.clientWidth - on.offsetWidth) / 2;
    document.title = "Christmas Party — Admin";
  }

  const countBy = (pred) => S.guests.filter(pred).length;
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  const leader = () => S.dates.find((d) => d.id === S.poll.winnerId) || null;
  const shortDay = (d) => fmtDay(d, { weekday: "short", month: "short", day: "numeric" });
  const ordinal = (n) => `${n}${["th", "st", "nd", "rd"][(n % 100 >= 11 && n % 100 <= 13) || n % 10 > 3 ? 0 : n % 10]}`;
  const stamp = (ms) => new Date(ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  // datetime-local wants the host's local wall-clock time.
  function toLocalInput(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    const p2 = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
  }

  function overview() {
    const todo = [];
    if (!S.party.code) todo.push(["settings", "Set the party code"]);
    if (!S.guests.length) todo.push(["guests", "Add guests"]);
    if (!S.dates.length) todo.push(["dates", "Add dates"]);
    if (!S.foods.length) todo.push(["food", "Add dishes"]);
    const final = S.dates.find((d) => d.id === S.finalDateId);
    const lead = leader();
    return `
      <div class="stats">
        <div class="stat"><b>${S.guests.length}</b><span>invited</span></div>
        <div class="stat"><b>${countBy((g) => g.claimed)}</b><span>signed in</span></div>
        <div class="stat"><b>${countBy((g) => g.respondedAt)}</b><span>responded</span></div>
        <div class="stat"><b>${countBy((g) => g.santa && g.respondedAt)}</b><span>in Secret Santa</span></div>
      </div>
      ${todo.length ? `<section class="card"><h3>Setup</h3><ul class="summary">${todo.map(([t, l]) =>
        `<li><span class="v">${l}</span><button class="btn link" data-tab="${t}">Go</button></li>`).join("")}</ul></section>` : ""}
      ${S.party.code ? `<section class="card">
        <h3>Invite link</h3>
        <p class="muted small">Party code: <b>${esc(S.party.code)}</b> at <a href="${esc(guestLink())}" target="_blank" rel="noopener">${esc(guestLink())}</a></p>
        <div class="linkbox"><input type="text" readonly value="${esc(inviteLink())}" onclick="this.select()" aria-label="Invite link"><button class="btn ghost small" data-act="copy-invite">Copy</button></div>
      </section>` : ""}
      <section class="card">
        <h3>Date</h3>
        <p class="muted">${final ? `Set: <b>${esc(fmtDate(final))}</b>` : lead ? `Leading: <b>${esc(fmtDate(lead))}</b> (ranked choice, ${plural(S.poll.ballots, "ballot")})` : "No votes yet."}</p>
        ${S.party.rsvpBy ? `<p class="muted small">RSVP by ${esc(stamp(S.party.rsvpBy))}${S.party.rsvpBy < Date.now() ? " (passed)" : ""}</p>` : ""}
        <button class="btn ghost small" data-tab="dates">View poll</button>
      </section>
      <section class="card">
        <h3>Secret Santa</h3>
        <p class="muted">${santaStatus()}</p>
        <button class="btn ghost small" data-tab="santa">Details</button>
      </section>`;
  }

  function santaStatus() {
    if (S.draw) return `Drawn ${esc(stamp(S.draw.at))} for ${S.draw.participants} people.`;
    const waiting = S.guests.filter((g) => !g.respondedAt);
    if (!S.guests.length) return "Add guests first.";
    return waiting.length
      ? `Not drawn yet. Waiting on ${plural(waiting.length, "guest")}: ${esc(waiting.map((g) => g.name).join(", "))}.`
      : "Not drawn yet. All guests have responded.";
  }

  function dates() {
    const poll = S.poll;
    const firsts = poll.rounds[0]?.counts || {};
    const max = Math.max(1, poll.ballots);
    const nameOf = (id) => {
      const d = S.dates.find((x) => x.id === id);
      return d ? shortDay(d) : "?";
    };
    const rows = S.dates.map((d) => {
      const final = d.id === S.finalDateId;
      const first = firsts[d.id] || 0;
      const byPos = {};
      for (const r of d.ranks) (byPos[r.pos] ||= []).push(r.name);
      const who = Object.entries(byPos).map(([pos, names]) => `<div><b>${ordinal(Number(pos))}:</b> ${esc(names.join(", "))}</div>`).join("");
      return `<li class="date-row${final ? " final" : ""}" style="grid-template-columns:1fr">
        <div class="row" style="align-items:center">
          <div class="date-label"><b>${esc(fmtDay(d))}${d.id === poll.winnerId && !final ? ` <span class="pill warn">winning</span>` : ""}${final ? ` <span class="pill ok">set</span>` : ""}</b>${d.time ? `<span>${esc(fmtTime(d))}</span>` : ""}<small>${plural(first, "first choice")} · ranked by ${d.ranks.length}</small></div>
          <span style="flex:0 0 auto;display:flex;gap:.4rem">
            ${final ? `<button class="btn ghost small" data-final="">Unset</button>` : `<button class="btn green small" data-final="${d.id}">Set date</button>`}
            <button class="btn ghost small" data-del-date="${d.id}" aria-label="Remove date">Remove</button>
          </span>
        </div>
        <div class="bar" aria-hidden="true"><i class="y" style="width:${(first / max) * 100}%"></i></div>
        <div class="who-list">${who || "Not ranked yet"}</div>
      </li>`;
    }).join("");
    const result = poll.ballots ? `<section class="card">
      <h3>Ranked-choice result</h3>
      <p>${poll.winnerId ? `Winner: <b>${esc(fmtDate(leader()))}</b>` : "No winner yet."} <span class="muted">${plural(poll.ballots, "ballot")}.</span></p>
      <ol class="rounds">${poll.rounds.map((r, i) => `<li><b>Round ${i + 1}:</b> ${Object.entries(r.counts).sort((a, b) => b[1] - a[1]).map(([id, n]) => `${esc(nameOf(id))} ${n}`).join(" · ")}${r.eliminated ? ` <span class="muted">→ ${esc(nameOf(r.eliminated))} out</span>` : ""}</li>`).join("")}</ol>
      ${S.noDates.length ? `<p class="muted small">None work: ${esc(S.noDates.join(", "))}</p>` : ""}
      <p class="hint">Each ballot counts for its highest-ranked date still in the running. The date with the fewest drops out until one has more than half.</p>
    </section>` : "";
    return `<section class="card">
      <h2>Dates</h2>
      <p class="lead">Guests rank the dates they can make. Setting a date shows it to all guests.</p>
      <form class="row" id="add-date">
        <label class="field" style="margin:0"><span>Date</span><input type="date" name="date" required></label>
        <label class="field" style="margin:0"><span>Start time <span class="muted small">(optional)</span></span><input type="time" name="time"></label>
        <button class="btn primary">Add date</button>
      </form>
    </section>
    ${result}
    ${S.dates.length ? `<section class="card"><ul class="dates">${rows}</ul></section>` : ""}`;
  }

  function food() {
    const rows = S.categories.flatMap((c) => S.foods.filter((f) => f.category === c)).map((f) => `
      <tr>
        <td data-label="Dish"><b>${esc(f.name)}</b></td>
        <td data-label="Category">${esc(f.category)}</td>
        <td data-label="How many"><input type="number" min="1" max="20" value="${f.slots}" data-slots="${f.id}" style="width:4.5rem;padding:.4rem .5rem" aria-label="How many people can bring ${esc(f.name)}"></td>
        <td data-label="Claimed by">${f.takenBy.length ? esc(f.takenBy.join(", ")) : '<span class="muted">open</span>'}${f.takenBy.length > f.slots ? ' <span class="pill bad">over</span>' : ""}</td>
        <td class="actions"><button class="btn ghost small" data-del-food="${f.id}">Remove</button></td>
      </tr>`).join("");
    const own = S.guests.filter((g) => g.custom.length);
    const open = S.foods.reduce((n, f) => n + Math.max(0, f.slots - f.takenBy.length), 0);
    return `<section class="card">
      <h2>Potluck</h2>
      <p class="lead">“How many” is the number of guests who can bring that dish.</p>
      <form class="row" id="add-food">
        <label class="field" style="margin:0;flex:2 1 12rem"><span>Dish</span><input type="text" name="name" maxlength="60" required></label>
        <label class="field" style="margin:0"><span>Category</span><select name="category">${S.categories.map((c) => `<option>${c}</option>`).join("")}</select></label>
        <label class="field" style="margin:0;flex:0 1 6rem"><span>How many</span><input type="number" name="slots" min="1" max="20" value="1"></label>
        <button class="btn primary">Add</button>
      </form>
    </section>
    ${S.foods.length ? `<section class="card">
      <p class="muted small" style="margin-top:0">${plural(open, "spot")} open.</p>
      <div class="table-scroll"><table class="table stack"><thead><tr><th>Dish</th><th>Category</th><th>How many</th><th>Claimed by</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>` : ""}
    ${own.length ? `<section class="card"><h3>Other dishes</h3><ul class="summary">${own.map((g) => `<li><span class="k">${esc(g.name)}</span><span class="v">${esc(g.custom.join(", "))}</span></li>`).join("")}</ul></section>` : ""}`;
  }

  function guestStatus(g) {
    if (g.respondedAt) return `<span class="pill ok">responded</span>`;
    if (g.claimed) return `<span class="pill warn">signed in</span>`;
    return `<span class="pill off">invited</span>`;
  }

  function guests() {
    const rows = S.guests.map((g) => editing === g.id
      ? `<tr><td colspan="5"><form class="inline-edit" data-edit-guest="${g.id}">
          <input type="text" name="name" value="${esc(g.name)}" maxlength="60" aria-label="Name" required>
          <input type="text" name="household" value="${esc(g.household)}" maxlength="40" placeholder="Household" aria-label="Household">
          <button class="btn green small">Save</button><button type="button" class="btn ghost small" data-act="cancel-edit">Cancel</button>
        </form></td></tr>`
      : `<tr>
        <td data-label="Guest"><b>${esc(g.name)}</b>${g.household ? `<div class="muted small">${esc(g.household)}</div>` : ""}</td>
        <td data-label="Status">${guestStatus(g)}</td>
        <td data-label="Bringing">${esc(g.food) || '<span class="muted">—</span>'}</td>
        <td data-label="Santa">${g.respondedAt || g.claimed ? (g.santa ? "In" : "Out") : '<span class="muted">—</span>'}</td>
        <td class="actions">
          <button class="btn ghost small" data-edit="${g.id}">Edit</button>
          ${g.inDraw ? "" : `<button class="btn ghost small" data-del-guest="${g.id}">Remove</button>`}
        </td>
      </tr>`).join("");
    return `<section class="card">
      <h2>Guests</h2>
      <p class="lead">Guests with the same household won't draw each other in Secret Santa.</p>
      <form class="row" id="add-guest">
        <label class="field" style="margin:0;flex:2 1 12rem"><span>Name</span><input type="text" name="name" maxlength="60" required></label>
        <label class="field" style="margin:0"><span>Household <span class="muted small">(optional)</span></span><input type="text" name="household" maxlength="40"></label>
        <button class="btn primary">Add guest</button>
      </form>
    </section>
    ${S.guests.length ? `<section class="card"><div class="table-scroll"><table class="table stack">
      <thead><tr><th>Guest</th><th>Status</th><th>Bringing</th><th>Santa</th><th></th></tr></thead><tbody>${rows}</tbody>
    </table></div>
    </section>` : ""}`;
  }

  function santa() {
    const ready = S.guests.filter((g) => g.respondedAt && g.santa);
    const waiting = S.guests.filter((g) => !g.respondedAt);
    const people = S.draw ? S.guests.filter((g) => g.inDraw) : ready;
    const pins = people.length ? `<section class="card">
      <h3>PINs</h3>
      <p class="muted small">${S.draw ? "Text each participant the link and their PIN." : "Send these once you draw names."}</p>
      <div class="table-scroll"><table class="table stack">
        <thead><tr><th>Participant</th><th>PIN</th><th></th></tr></thead>
        <tbody>${people.map((g) => `<tr>
          <td data-label="Participant"><b>${esc(g.name)}</b></td>
          <td data-label="PIN"><code class="pin">${esc(g.pin)}</code></td>
          <td class="actions">
            ${S.draw ? `<a class="btn green small" href="sms:?&body=${encodeURIComponent(pinMessage(g))}">Text</a>
            <button class="btn ghost small" data-copy-msg="${g.id}">Copy</button>` : ""}
            <button class="btn ghost small" data-new-pin="${g.id}">New PIN</button>
          </td>
        </tr>`).join("")}</tbody>
      </table></div>
      ${S.draw ? `<p class="hint">Text opens your messages app with the link and PIN filled in. Copy copies the same message.</p>` : ""}
    </section>` : "";
    return `<section class="card">
      <h2>Secret Santa</h2>
      <p class="lead">Draw names once you have your headcount. Everyone who responded and joined Secret Santa is included. Guests see their match on the Secret Santa page with their PIN; matches aren't shown here.</p>
      <p>${santaStatus()}</p>
      ${S.draw ? `<button class="btn danger" data-act="cancel-draw">Cancel draw</button>
        <p class="hint">Cancelling deletes all matches. When you draw again everyone gets a new match.</p>`
      : `<button class="btn green" data-act="draw" ${ready.length < S.minSantas ? "disabled" : ""}>Draw names (${plural(ready.length, "participant")})</button>
        <p class="hint">${waiting.length ? `Not included: ${esc(waiting.map((g) => g.name).join(", "))}. ` : ""}Minimum ${S.minSantas} participants.</p>`}
    </section>
    ${pins}`;
  }

  function settings() {
    const p = S.party;
    const f = (name, label, opts = "") => `<label class="field"><span>${label}</span><input type="text" name="${name}" value="${esc(p[name])}" ${opts}></label>`;
    return `<section class="card">
      <h2>Party details</h2>
      <form id="party">
        <label class="field"><span>Details for guests</span><textarea name="details" maxlength="2000" >${esc(p.details)}</textarea></label>
        ${f("budget", "Secret Santa budget", 'maxlength="40" placeholder="$25"')}
        <label class="field"><span>Secret Santa note</span><textarea name="santaNote" maxlength="500" >${esc(p.santaNote)}</textarea></label>
        <label class="field"><span>RSVP by</span><input type="datetime-local" name="rsvpBy" value="${toLocalInput(p.rsvpBy)}"></label>
        <span class="hint">Shows a countdown on the RSVP page. Leave empty for none.</span>
        ${f("code", "Party code", 'maxlength="40" autocapitalize="characters" placeholder="JINGLE"')}
        <span class="hint">Not case-sensitive. Leave empty to block new sign-ins.</span>
        <div class="nav"><button class="btn primary">Save</button></div>
      </form>
    </section>
    <section class="card">
      <h3>Backup</h3>
      <p class="muted small">Save the guest list and potluck dishes to a file, and load them back after a reset. Importing adds to what's here and skips names already listed. PINs are kept.</p>
      <div class="row" style="align-items:center">
        <button class="btn ghost" data-act="export">Export</button>
        <label class="btn ghost" style="flex:0 0 auto">Import<input type="file" id="import-file" accept=".json,application/json" hidden></label>
      </div>
    </section>
    <section class="card danger-zone">
      <h3>Start over</h3>
      <p class="muted small">Deletes all guests, votes, dishes and the draw. Export first to keep the guest list and dishes.</p>
      <form class="row" id="reset">
        <label class="field" style="margin:0"><span>Type RESET</span><input type="text" name="confirm" autocomplete="off"></label>
        <button class="btn danger">Reset</button>
      </form>
    </section>`;
  }

  // ---------- actions ----------

  const datesBody = (list) => ({ dates: list.map((d) => ({ id: d.id, date: d.date, time: d.time })) });
  const foodsBody = (list) => ({ foods: list.map((f) => ({ id: f.id, name: f.name, category: f.category, slots: f.slots })) });

  async function act(fn, okMsg) {
    try {
      await fn();
      render();
      if (okMsg) toast(okMsg);
    } catch {}
  }

  app.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = Object.fromEntries(new FormData(form));
    if (form.id === "login") return login(data.password ?? form.querySelector("#pw").value);
    if (form.id === "add-date") return act(() => call("PUT", "dates", datesBody([...S.dates, { date: data.date, time: data.time }])), "Date added");
    if (form.id === "add-food") {
      return act(() => call("PUT", "foods", foodsBody([...S.foods, data])), `${data.name} added`)
        .then(() => app.querySelector("#add-food [name=name]")?.focus());
    }
    if (form.id === "add-guest") {
      return act(() => call("POST", "guests", data), `${data.name} added`)
        .then(() => app.querySelector("#add-guest [name=name]")?.focus());
    }
    if (form.dataset.editGuest) {
      editing = null;
      return act(() => call("PUT", `guests/${form.dataset.editGuest}`, data), "Saved");
    }
    if (form.id === "party") {
      data.rsvpBy = data.rsvpBy ? new Date(data.rsvpBy).getTime() : null;
      return act(() => call("PUT", "party", data), "Saved");
    }
    if (form.id === "reset") {
      if (data.confirm !== "RESET") return toast("Type RESET to confirm.", true);
      return act(() => call("POST", "reset", { confirm: "RESET" }), "Reset");
    }
  });

  function exportFile() {
    const data = {
      type: "christmas-party",
      version: 1,
      exportedAt: new Date().toISOString(),
      guests: S.guests.map((g) => ({ name: g.name, household: g.household || "", pin: g.pin })),
      foods: S.foods.map((f) => ({ name: f.name, category: f.category, slots: f.slots })),
    };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = `christmas-party-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast(`Exported ${plural(data.guests.length, "guest")} and ${plural(data.foods.length, "dish", "dishes")}`);
  }

  async function importFile(input) {
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return toast("That isn't an export file.", true);
    }
    if (data?.type !== "christmas-party") return toast("That isn't an export file.", true);
    try {
      const r = await call("POST", "import", { guests: data.guests, foods: data.foods });
      render();
      const n = r.imported;
      toast(`Added ${plural(n.guests, "guest")} and ${plural(n.foods, "dish", "dishes")}${n.skipped ? ` (${n.skipped} already listed)` : ""}`);
    } catch {}
  }

  app.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "import-file") return importFile(t);
    if (t.dataset.slots) {
      const list = S.foods.map((f) => (f.id === t.dataset.slots ? { ...f, slots: Number(t.value) } : f));
      act(() => call("PUT", "foods", foodsBody(list)));
    }
  });

  app.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    const d = b.dataset;
    if (d.tab) {
      tab = d.tab;
      editing = null;
      try { sessionStorage.setItem("xmas.admin.tab", tab); } catch {}
      window.scrollTo({ top: 0 });
      return render();
    }
    if ("final" in d) return act(() => call("PUT", "final-date", { id: d.final || null }), d.final ? "Date set" : "Date unset");
    if (d.delDate) {
      const date = S.dates.find((x) => x.id === d.delDate);
      if (date.ranks.length && !confirm(`Remove ${fmtDay(date)}? ${plural(date.ranks.length, "guest has", "guests have")} ranked it.`)) return;
      return act(() => call("PUT", "dates", datesBody(S.dates.filter((x) => x.id !== d.delDate))), "Date removed");
    }
    if (d.delFood) {
      const f = S.foods.find((x) => x.id === d.delFood);
      if (f.takenBy.length && !confirm(`Remove ${f.name}? ${f.takenBy.join(", ")} will need to choose another dish.`)) return;
      return act(() => call("PUT", "foods", foodsBody(S.foods.filter((x) => x.id !== d.delFood))), "Dish removed");
    }
    if (d.edit) {
      editing = d.edit;
      render();
      return app.querySelector("[data-edit-guest] input")?.focus();
    }
    if (d.copyMsg) return copyText(pinMessage(S.guests.find((x) => x.id === d.copyMsg)));
    if (d.newPin) {
      const g = S.guests.find((x) => x.id === d.newPin);
      if (!confirm(`Give ${g.name} a new PIN? The old one stops working.`)) return;
      return act(() => call("POST", `guests/${d.newPin}/pin`, {}), `New PIN for ${g.name}`);
    }
    if (d.delGuest) {
      const g = S.guests.find((x) => x.id === d.delGuest);
      if (!confirm(`Remove ${g.name} from the party?`)) return;
      return act(() => call("DELETE", `guests/${d.delGuest}`), `${g.name} removed`);
    }

    switch (d.act) {
      case "cancel-edit": editing = null; return render();
      case "export": return exportFile();
      case "copy-invite": return copyText(inviteLink());
      case "draw": {
        const waiting = S.guests.filter((g) => !g.respondedAt);
        if (!confirm(waiting.length ? `Draw now? ${waiting.map((g) => g.name).join(", ")} haven't responded and won't be included.` : "Draw names now?")) return;
        return act(() => call("POST", "draw", {}), "Names drawn");
      }
      case "cancel-draw":
        if (!confirm("Cancel the draw? All matches will be deleted.")) return;
        return act(() => call("POST", "draw/cancel", {}), "Draw cancelled");
    }
  });

  document.getElementById("logout").addEventListener("click", () => signOut("Signed out."));

  // Keep the numbers fresh, but never redraw under someone mid-edit.
  setInterval(async () => {
    if (!token || !S || document.hidden || editing || tab === "settings") return;
    if (app.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    try {
      await call("GET", "state");
      render();
    } catch {}
  }, 15000);

  if (token) load();
  else renderLogin();
})();
