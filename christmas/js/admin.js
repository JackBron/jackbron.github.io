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
    document.title = "Christmas Party — Admin";
  }

  const countBy = (pred) => S.guests.filter(pred).length;
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  function leader() {
    let best = null;
    for (const d of S.dates) {
      const score = d.votes.yes.length * 2 + d.votes.maybe.length;
      if (!best || score > best.score) best = { d, score };
    }
    return best && best.score > 0 ? best.d : null;
  }

  function overview() {
    const todo = [];
    if (!S.party.code) todo.push(["settings", "Set the party code"]);
    if (!S.guests.length) todo.push(["guests", "Add guests"]);
    if (!S.dates.length) todo.push(["dates", "Add dates"]);
    if (!S.foods.length) todo.push(["food", "Add dishes"]);
    const p = S.providers;
    if (!p.email && !p.sms) todo.push(["santa", "Configure email or text delivery"]);
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
        <p class="muted">${final ? `Set: <b>${esc(fmtDate(final))}</b>` : lead ? `Leading: <b>${esc(fmtDate(lead))}</b> (${lead.votes.yes.length} yes, ${lead.votes.maybe.length} maybe)` : "No votes yet."}</p>
        <button class="btn ghost small" data-tab="dates">View poll</button>
      </section>
      <section class="card">
        <h3>Secret Santa</h3>
        <p class="muted">${santaStatus()}</p>
        <button class="btn ghost small" data-tab="santa">Details</button>
      </section>`;
  }

  function santaStatus() {
    if (S.draw) {
      const sent = countBy((g) => ["sent", "dry-run"].includes(g.notify?.status));
      const failed = countBy((g) => g.notify?.status === "failed");
      return `Drawn ${new Date(S.draw.at).toLocaleString()} for ${S.draw.participants} people. ${sent} sent${failed ? `, <b style="color:var(--red)">${failed} failed</b>` : ""}.`;
    }
    const waiting = S.guests.filter((g) => !g.respondedAt);
    if (S.drawError) return esc(S.drawError);
    if (!S.guests.length) return "Add guests first.";
    return waiting.length
      ? `Waiting on ${plural(waiting.length, "guest")}: ${esc(waiting.map((g) => g.name).join(", "))}. Names are drawn when everyone has responded.`
      : "All guests have responded.";
  }

  function dates() {
    const lead = leader();
    const max = Math.max(1, S.guests.length);
    const rows = S.dates.map((d) => {
      const y = d.votes.yes.length, m = d.votes.maybe.length, n = d.votes.no.length;
      const final = d.id === S.finalDateId;
      const names = (k, label) => d.votes[k].length ? `<div><b>${label}:</b> ${esc(d.votes[k].join(", "))}</div>` : "";
      return `<li class="date-row${final ? " final" : ""}" style="grid-template-columns:1fr">
        <div class="row" style="align-items:center">
          <div class="date-label"><b>${esc(fmtDay(d))}${d === lead && !final ? ` <span class="pill warn">leading</span>` : ""}${final ? ` <span class="pill ok">set</span>` : ""}</b>${d.time ? `<span>${esc(fmtTime(d))}</span>` : ""}</div>
          <span style="flex:0 0 auto;display:flex;gap:.4rem">
            ${final ? `<button class="btn ghost small" data-final="">Unset</button>` : `<button class="btn green small" data-final="${d.id}">Set date</button>`}
            <button class="btn ghost small" data-del-date="${d.id}" aria-label="Remove date">Remove</button>
          </span>
        </div>
        <div class="bar" aria-hidden="true"><i class="y" style="width:${(y / max) * 100}%"></i><i class="m" style="width:${(m / max) * 100}%"></i><i class="n" style="width:${(n / max) * 100}%"></i></div>
        <div class="who-list">${names("yes", "Yes")}${names("maybe", "Maybe")}${names("no", "No")}${y + m + n === 0 ? "No votes yet" : ""}</div>
      </li>`;
    }).join("");
    return `<section class="card">
      <h2>Dates</h2>
      <p class="lead">Setting a date shows it to all guests.</p>
      <form class="row" id="add-date">
        <label class="field" style="margin:0"><span>Date</span><input type="date" name="date" required></label>
        <label class="field" style="margin:0"><span>Start time <span class="muted small">(optional)</span></span><input type="time" name="time"></label>
        <button class="btn primary">Add date</button>
      </form>
    </section>
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
    const own = S.guests.filter((g) => g.food && !S.foods.some((f) => f.takenBy.includes(g.name)));
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
    ${own.length ? `<section class="card"><h3>Other dishes</h3><ul class="summary">${own.map((g) => `<li><span class="k">${esc(g.name)}</span><span class="v">${esc(g.food)}</span></li>`).join("")}</ul></section>` : ""}`;
  }

  function guestStatus(g) {
    if (g.respondedAt) return `<span class="pill ok">responded</span>`;
    if (g.claimed) return `<span class="pill warn">signed in</span>`;
    return `<span class="pill off">invited</span>`;
  }

  function guests() {
    const rows = S.guests.map((g) => editing === g.id
      ? `<tr><td colspan="6"><form class="inline-edit" data-edit-guest="${g.id}">
          <input type="text" name="name" value="${esc(g.name)}" maxlength="60" aria-label="Name" required>
          <input type="text" name="household" value="${esc(g.household)}" maxlength="40" placeholder="Household" aria-label="Household">
          <button class="btn green small">Save</button><button type="button" class="btn ghost small" data-act="cancel-edit">Cancel</button>
        </form></td></tr>`
      : `<tr>
        <td data-label="Guest"><b>${esc(g.name)}</b>${g.household ? `<div class="muted small">${esc(g.household)}</div>` : ""}</td>
        <td data-label="Status">${guestStatus(g)}</td>
        <td data-label="Bringing">${esc(g.food) || '<span class="muted">—</span>'}</td>
        <td data-label="Contact">${g.contact ? esc(g.contact.value) : '<span class="muted">—</span>'}</td>
        <td data-label="Santa">${g.respondedAt || g.claimed ? (g.santa ? "In" : "Out") : '<span class="muted">—</span>'}</td>
        <td class="actions">
          <button class="btn ghost small" data-edit="${g.id}">Edit</button>
          ${g.claimed && !g.inDraw ? `<button class="btn ghost small" data-release="${g.id}" title="Free this name so it can be claimed again">Release</button>` : ""}
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
      <thead><tr><th>Guest</th><th>Status</th><th>Bringing</th><th>Contact</th><th>Santa</th><th></th></tr></thead><tbody>${rows}</tbody>
    </table></div>
    <p class="hint">Release frees a claimed name. It's unavailable after the draw.</p>
    </section>` : ""}`;
  }

  function notifyPill(n) {
    if (!n) return '<span class="muted">—</span>';
    const map = { sent: ["ok", "sent"], "dry-run": ["warn", "dry run"], pending: ["warn", "queued"], sending: ["warn", "sending"], failed: ["bad", "failed"] };
    const [cls, label] = map[n.status] || ["off", n.status];
    return `<span class="pill ${cls}">${label}</span>${n.error ? `<div class="muted small">${esc(n.error)}</div>` : ""}`;
  }

  function santa() {
    const p = S.providers;
    const ready = S.guests.filter((g) => g.respondedAt && g.santa);
    const waiting = S.guests.filter((g) => !g.respondedAt);
    const failed = countBy((g) => g.notify?.status === "failed");
    const rows = S.guests.filter((g) => g.inDraw).map((g) => `<tr>
      <td data-label="Guest"><b>${esc(g.name)}</b></td>
      <td data-label="Sent to">${g.contact ? esc(g.contact.value) : "—"}</td>
      <td data-label="Delivery">${notifyPill(g.notify)}</td>
      <td class="actions"><button class="btn ghost small" data-resend="${g.id}">Resend</button></td>
    </tr>`).join("");
    return `<section class="card">
      <h2>Secret Santa</h2>
      <p class="lead">Names are drawn when all guests have responded. Matches are sent to each participant and aren't shown here.</p>
      <p>${santaStatus()}</p>
      ${S.draw ? `<div class="row" style="flex-wrap:wrap">
          ${failed ? `<button class="btn primary" data-act="resend-failed">Resend ${plural(failed, "failed message")}</button>` : ""}
          <button class="btn danger" data-act="cancel-draw">Cancel draw</button>
        </div>
        <p class="hint">Cancelling deletes all matches. Names are drawn again later and new messages are sent.</p>`
      : `<button class="btn green" data-act="draw" ${ready.length < S.minSantas ? "disabled" : ""}>Draw now (${plural(ready.length, "participant")})</button>
        <p class="hint">${waiting.length ? `Not included: ${esc(waiting.map((g) => g.name).join(", "))}. ` : ""}Minimum ${S.minSantas} participants.</p>`}
    </section>
    ${S.draw ? `<section class="card"><h3>Delivery</h3><div class="table-scroll"><table class="table stack"><thead><tr><th>Santa</th><th>Sent to</th><th>Delivery</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="hint">Guests can also view their match on the RSVP page. Only the guest can change their contact; changing it resends the match.</p></section>` : ""}
    <section class="card">
      <h3>Delivery setup</h3>
      <ul class="summary">
        <li><span class="k">Email</span><span class="v">${p.email ? `<span class="pill ${p.email === "dry-run" ? "warn" : "ok"}">${esc(p.email)}</span>` : '<span class="pill off">not set up</span>'}</span></li>
        <li><span class="k">Text</span><span class="v">${p.sms ? `<span class="pill ${p.sms === "dry-run" ? "warn" : "ok"}">${esc(p.sms)}</span>` : '<span class="pill off">not set up</span>'}</span></li>
      </ul>
      ${p.email === "dry-run" ? `<p class="note">Dry run is on: messages are logged, not sent. For local testing only.</p>` : ""}
      <form class="row" id="test-send" style="margin-top:1rem">
        <label class="field" style="margin:0;flex:2 1 14rem"><span>Test message</span><input type="text" name="contact" placeholder="Phone or email"></label>
        <button class="btn ghost">Send test</button>
      </form>
    </section>`;
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
        ${f("code", "Party code", 'maxlength="40" autocapitalize="characters" placeholder="JINGLE"')}
        <span class="hint">Not case-sensitive. Leave empty to block new sign-ins.</span>
        <div class="nav"><button class="btn primary">Save</button></div>
      </form>
    </section>
    <section class="card danger-zone">
      <h3>Start over</h3>
      <p class="muted small">Deletes all guests, votes, dishes and the draw.</p>
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
    if (form.id === "party") return act(() => call("PUT", "party", data), "Saved");
    if (form.id === "reset") {
      if (data.confirm !== "RESET") return toast("Type RESET to confirm.", true);
      return act(() => call("POST", "reset", { confirm: "RESET" }), "Reset");
    }
    if (form.id === "test-send") {
      try {
        const r = await call("POST", "notify/test", { contact: data.contact });
        toast(r.ok ? `Test ${r.status === "dry-run" ? "logged (dry run)" : "sent"} to ${r.to}` : `Failed: ${r.error}`, !r.ok);
      } catch {}
    }
  });

  app.addEventListener("change", (e) => {
    const t = e.target;
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
      const votes = date.votes.yes.length + date.votes.maybe.length + date.votes.no.length;
      if (votes && !confirm(`Remove ${fmtDay(date)}? ${plural(votes, "vote")} on it will be lost.`)) return;
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
    if (d.release) {
      const g = S.guests.find((x) => x.id === d.release);
      if (!confirm(`Release ${g.name}? They will be signed out and the name can be claimed again.`)) return;
      return act(() => call("POST", `guests/${d.release}/release`, {}), `${g.name} released`);
    }
    if (d.delGuest) {
      const g = S.guests.find((x) => x.id === d.delGuest);
      if (!confirm(`Remove ${g.name} from the party?`)) return;
      return act(() => call("DELETE", `guests/${d.delGuest}`), `${g.name} removed`);
    }
    if (d.resend) return act(() => call("POST", "notify/resend", { guestId: d.resend }), "Queued to resend");

    switch (d.act) {
      case "cancel-edit": editing = null; return render();
      case "copy-invite": return copyText(inviteLink());
      case "draw": {
        const waiting = S.guests.filter((g) => !g.respondedAt);
        if (!confirm(waiting.length ? `Draw now? ${waiting.map((g) => g.name).join(", ")} haven't responded and won't be included.` : "Draw names now?")) return;
        return act(() => call("POST", "draw", {}), "Names drawn and sent");
      }
      case "cancel-draw":
        if (!confirm("Cancel the draw? All matches will be deleted.")) return;
        return act(() => call("POST", "draw/cancel", {}), "Draw cancelled");
      case "resend-failed": return act(() => call("POST", "notify/resend", {}), "Queued to resend");
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
