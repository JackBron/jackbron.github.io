// Delivers Secret Santa matches by email (Resend or Brevo) or SMS (Twilio).
// Nothing here is logged except in dry-run mode, which exists for local testing
// and must never be switched on in production: it prints the match to the log.

function emailProvider(env) {
  const p = String(env.EMAIL_PROVIDER || "").toLowerCase();
  return ["resend", "brevo"].includes(p) && env.EMAIL_API_KEY && env.EMAIL_FROM ? p : null;
}

function smsReady(env) {
  return !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);
}

const dryRun = (env) => env.NOTIFY_DRY_RUN === "1";

export function providerStatus(env) {
  if (dryRun(env)) return { email: "dry-run", sms: "dry-run" };
  return { email: emailProvider(env), sms: smsReady(env) ? "twilio" : null };
}

export async function sendMessage(env, contact, msg) {
  if (dryRun(env)) {
    console.log(`[dry-run] ${contact.type} to ${contact.value}\n${msg.subject}\n${msg.text}`);
    return { ok: true, status: "dry-run" };
  }
  if (contact.type === "email") {
    const p = emailProvider(env);
    if (!p) return { ok: false, permanent: true, error: "Email sending isn't set up on the Worker." };
    return p === "resend" ? resend(env, contact.value, msg) : brevo(env, contact.value, msg);
  }
  if (!smsReady(env)) return { ok: false, permanent: true, error: "Text messaging isn't set up on the Worker." };
  return twilio(env, contact.value, msg.text);
}

async function outcome(res, via) {
  if (res.ok) return { ok: true, status: "sent", via };
  let detail = "";
  try {
    const j = await res.json();
    detail = j.message || j.error?.message || j.code || "";
  } catch {}
  return {
    ok: false,
    permanent: res.status >= 400 && res.status < 500 && res.status !== 429,
    error: `${via} ${res.status}${detail ? `: ${detail}` : ""}`,
  };
}

function parseFrom(from) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  return m ? { name: m[1].replace(/^"|"$/g, ""), email: m[2] } : { email: from.trim() };
}

function toHtml(text) {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div style="font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.55;color:#1d2b22">${esc.replace(/\n/g, "<br>")}</div>`;
}

async function resend(env, to, msg) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.EMAIL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject: msg.subject, text: msg.text, html: toHtml(msg.text) }),
  });
  return outcome(res, "Resend");
}

async function brevo(env, to, msg) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": env.EMAIL_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      sender: parseFrom(env.EMAIL_FROM),
      to: [{ email: to }],
      subject: msg.subject,
      textContent: msg.text,
      htmlContent: toHtml(msg.text),
    }),
  });
  return outcome(res, "Brevo");
}

async function twilio(env, to, text) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const body = new URLSearchParams({ To: to, Body: text });
  // A Messaging Service SID (MG…) picks the sending number itself.
  body.set(env.TWILIO_FROM.startsWith("MG") ? "MessagingServiceSid" : "From", env.TWILIO_FROM);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${sid}:${env.TWILIO_AUTH_TOKEN}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  return outcome(res, "Twilio");
}
