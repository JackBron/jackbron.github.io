(() => {
  const app = document.getElementById("app");
  const PIN_KEY = "xmas.pin";
  const pinStore = {
    get() { try { return localStorage.getItem(PIN_KEY) || ""; } catch { return ""; } },
    set(v) { try { v ? localStorage.setItem(PIN_KEY, v) : localStorage.removeItem(PIN_KEY); } catch {} },
  };
  let data = null;        // POST /api/santa result
  let opened = false;

  function viewPin(msg, pin = "") {
    app.innerHTML = `<section class="card festive">
      <h2>Enter your PIN</h2>
      <p class="lead">The host texted you a 6-digit PIN.</p>
      <form id="pin-form" autocomplete="off">
        <input id="pin" class="code-input pin-input" type="text" inputmode="numeric" autocomplete="one-time-code" aria-label="PIN" value="${esc(pin)}" required>
        <p class="err" id="pin-err" role="alert">${esc(msg || "")}</p>
        <button class="btn primary block">Continue</button>
      </form>
    </section>`;
    app.querySelector("#pin").focus();
  }

  function viewMatch() {
    const m = data.match;
    if (!m) {
      app.innerHTML = `<section class="card"><h2>Hi ${esc(firstWord(data.name))}</h2><p class="muted">You're not in this year's draw. Contact the host if that's a mistake.</p></section>${signOut()}`;
      return;
    }
    const p = data.party;
    app.innerHTML = `<section class="card festive">
      <h2>Hi ${esc(firstWord(data.name))}</h2>
      ${opened
        ? `<div class="match"><div class="for">You're buying for</div><div class="who">${esc(m.name)}</div>
            ${m.hints ? `<blockquote>${esc(m.hints)}</blockquote>` : `<p class="muted small">No gift ideas listed.</p>`}
          </div>
          <ul class="summary" style="margin-top:1rem">
            ${p.budget ? `<li><span class="k">Budget</span><span class="v">${esc(p.budget)}</span></li>` : ""}
            ${data.finalDate ? `<li><span class="k">Party</span><span class="v">${esc(fmtDate(data.finalDate))}</span></li>` : ""}
          </ul>
          ${p.santaNote ? `<p class="note" style="margin-top:1rem">${esc(p.santaNote)}</p>` : ""}
          <p class="center"><button class="btn link" data-act="hide">Hide</button></p>`
        : `<p class="lead">Tap the gift to see who you're buying for. Keep it to yourself.</p>
          <button class="reveal" data-act="open"><span>Open</span></button>`}
    </section>${signOut()}`;
  }

  const firstWord = (s) => String(s).trim().split(/\s+/)[0];
  const signOut = () => `<p class="muted small center"><button class="btn link" data-act="sign-out">Not ${esc(firstWord(data.name))}? Sign out</button></p>`;

  async function login(pin, quiet) {
    try {
      data = await Api.call("POST", "/api/santa", { pin });
      pinStore.set(pin);
      viewMatch();
    } catch (e) {
      if (e.status === 409) {
        app.innerHTML = `<section class="card"><h2>Not live yet</h2><p class="muted">Names haven't been drawn. The host will text you a PIN when Secret Santa is live.</p><p><a class="btn ghost" href="../">Back to the RSVP</a></p></section>`;
        return;
      }
      if (e.status === 403) pinStore.set(null);
      viewPin(quiet && e.status === 403 ? "" : e.message, quiet ? "" : pin);
    }
  }

  app.addEventListener("submit", (e) => {
    if (e.target.id !== "pin-form") return;
    e.preventDefault();
    const pin = document.getElementById("pin").value.replace(/\D/g, "");
    if (pin.length !== 6) return (document.getElementById("pin-err").textContent = "The PIN is 6 digits.");
    e.target.querySelector("button").disabled = true;
    login(pin).finally(() => { const b = app.querySelector("#pin-form button"); if (b) b.disabled = false; });
  });

  app.addEventListener("input", (e) => {
    if (e.target.id === "pin") e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
  });

  app.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    switch (b.dataset.act) {
      case "open": opened = true; return viewMatch();
      case "hide": opened = false; return viewMatch();
      case "sign-out":
        pinStore.set(null);
        data = null;
        opened = false;
        return viewPin();
    }
  });

  if (!Api.configured) {
    app.innerHTML = `<section class="card"><h2>Not configured</h2><p class="muted">Set <code>API_DEFAULT</code> in <code>christmas/js/api.js</code> to the Worker URL.</p></section>`;
  } else if (pinStore.get()) {
    login(pinStore.get(), true);
  } else {
    viewPin();
  }
})();
