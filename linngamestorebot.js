/**
 * gamestore-auth-worker.js
 *
 * Standalone Cloudflare Worker — Telegram login for the Linn Game Store customer
 * website (linngamestorebot). Kept completely separate from the existing
 * telegram-order worker (which uses the admin/order bot) on purpose.
 *
 * Endpoints:
 *   POST /auth/miniapp       { initData: string }
 *   POST /auth/widget        { id, first_name, last_name?, username?, photo_url?, auth_date, hash }
 *   POST /notify-connected   { telegramId, guestId, name, balance } — pushes a
 *                             "Telegram Connected" DM (called from index.html
 *                             right after a first-time Telegram link)
 *   POST /telegram-webhook   Telegram Bot API update — /start, /menu, /help,
 *                             an inline_query handler (handleInlineQuery,
 *                             requires /setinline enabled via BotFather —
 *                             lets anyone type "@linngamestorebot <text>" in
 *                             any chat to search games and drop an "Open
 *                             Linn Game Store" link, no need to open the bot chat)
 *                             and the Game List/Wallet/My Orders/My
 *                             Account/Top Up Wallet/Help Center/Open Linn
 *                             Game Store reply keyboard for linngamestorebot,
 *                             including:
 *                               - an in-chat Wallet Top Up flow (amount ->
 *                                 payment method -> confirm -> receipt
 *                                 photo) that writes the same
 *                                 "walletTopups" Firestore doc store.html
 *                                 does and pings the order-approval Worker
 *                                 so the existing admin Confirm/Reject flow
 *                                 picks it up. The confirm step shows the
 *                                 amount + method picked with ✅ Confirm /
 *                                 ✏️ Edit buttons before ever asking for a
 *                                 receipt; "🔙 Change Amount" and
 *                                 "🔙 Change Method" are available on both
 *                                 the confirm step and the receipt prompt,
 *                                 so a wrong amount/method no longer means
 *                                 Cancel + restart from scratch. If the
 *                                 receipt upload itself fails (ImgBB down,
 *                                 etc.), the customer gets a "🔄
 *                                 ထပ်ကြိုးစားမည်" button that retries the
 *                                 exact same photo (its file_id is stashed
 *                                 on the session) instead of forcing a
 *                                 re-send. A session left mid-flow for 10
 *                                 minutes (2 min before the 12-min
 *                                 SESSION_TIMEOUT_MS) gets a one-time "⏰ 2
 *                                 minutes left" DM via the `scheduled`
 *                                 export/warnExpiringTopupSessions() below,
 *                                 and once it actually hits 12 minutes with
 *                                 no reply it's auto-cancelled with a
 *                                 "Session Expired" DM via
 *                                 expireStaleTopupSessions() — both require
 *                                 a Cron Trigger added to wrangler.toml (see
 *                                 the comment on `scheduled` in the default
 *                                 export). Also, tapping ➕ Top Up Wallet now
 *                                 shows quick preset amount buttons
 *                                 (QUICK_TOPUP_AMOUNTS) alongside the "type
 *                                 an amount" prompt, and each payment
 *                                 method's list entry shows no badge (just
 *                                 the note text below the list) when
 *                                 admin.html's Availability Note field is
 *                                 set for that method, and enforces that
 *                                 method's optional minAmount/maxAmount
 *                                 against the amount already entered.
 *                               - an in-chat Game List flow ("gl:" callback
 *                                 data): Top Up / Voucher -> genre filter
 *                                 chips (All / MOBA / Battle Royale /
 *                                 Survival / Fun / Creative — same ids as
 *                                 index.html's GAME_CATEGORIES, filtering on
 *                                 each game's `category` field) -> paged
 *                                 game list (grouped by name; a game with
 *                                 2+ server/region uploads shows as
 *                                 "Name (N)") -> server picker for
 *                                 multi-server games -> a web_app "Open in
 *                                 App" button pointed at
 *                                 "<STORE_URL>?game=<id>", which index.html
 *                                 already deep-links straight into that
 *                                 game's product card
 *                               - Help Center now also offers "❓ FAQ" (a
 *                                 static bot-answered list, FAQ_ITEMS,
 *                                 which itself now ends with a "💬 Help
 *                                 Center" shortcut button back out) and
 *                                 "🔍 Track my order" (look up any order by
 *                                 exact ID via lookupOrderById(), not just
 *                                 the 5 most recent)
 *                               - "🌐 Language" is a button on the persistent
 *                                 reply keyboard (MAIN_KEYBOARD) and also
 *                                 works via the /language command
 *                                 (sendLanguagePicker())
 *                               - "📦 My Orders" now attaches a "🧾 details"
 *                                 inline button per order (handleOrderDetail
 *                                 Callback) showing the full timeline/date/
 *                                 payment method/receipt for that one order
 *                             Every /start (or /menu) is upserted into
 *                             Firestore's "telegramBotUsers/{telegramId}"
 *                             (chatId, name, lastSeen) — this is the
 *                             audience list /admin/broadcast below sends to.
 *   POST /admin/broadcast    { secret, text, buttonText?, buttonUrl? } —
 *                             admin-triggered DM to every "telegramBotUsers"
 *                             entry (i.e. everyone who has pressed /start).
 *                             Meant to be called once from admin.html right
 *                             after the admin flips settings/gameAccounts
 *                             .enabled on and publishes listings, to tell
 *                             every bot user "Account ဝယ်လို့ရပါပြီ" — but
 *                             it's a generic broadcaster, so it works for
 *                             any future announcement too. `secret` must
 *                             match ADMIN_BROADCAST_SECRET. Requires
 *                             `text`; `buttonText`+`buttonUrl` are optional
 *                             (adds one web_app "Open in App" button, e.g.
 *                             buttonUrl: STORE_URL). Responds immediately
 *                             ({ ok: true, accepted: true, recipients: N })
 *                             and sends in the background (Worker
 *                             waitUntil) since a large user list can take
 *                             longer than a single request should block on;
 *                             per-recipient failures (bot blocked by that
 *                             user, etc.) are swallowed — a 403 "blocked by
 *                             user" response from Telegram also deletes
 *                             that person's telegramBotUsers entry so
 *                             future broadcasts stop retrying them.
 *                             Point Telegram's
 *                             webhook here after deploy:
 *                             https://api.telegram.org/bot<TOKEN>/setWebhook?url=<this-worker-url>/telegram-webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
 *   (Order status DMs are "live": Pending/Processing edit ONE message per order;
 *    Success/Fail replace it with a final message — see deliverOrderStatusMessage.)
 *   POST /notify-order-status { secret, telegramId, orderId, status, game?,
 *                             price?, note?, userName?, userId?, inGameId?,
 *                             serverId?, packageName? } — admin-triggered DM
 *                             to one customer when their order's status
 *                             changes (Pending/Processing/Success/Fail),
 *                             called from admin.html's
 *                             notifyOrderStatusChange() right after the
 *                             "orders/{id}" write that changes it.
 *                             `secret` must match ADMIN_BROADCAST_SECRET
 *                             (same shared secret as /admin/broadcast).
 *                             `telegramId` is users/{uid}.telegramId — for a
 *                             one-on-one Telegram chat chat_id === that id,
 *                             so this doesn't need a telegramBotUsers lookup.
 *                             On a Success/confirm push, the optional
 *                             userName/userId/inGameId/serverId/packageName
 *                             fields (all read straight off the order doc by
 *                             admin.html — no extra Firestore read) get
 *                             rendered as a full order-details block (with a
 *                             ✅/❌/⏳ status badge) instead of the plain
 *                             one-line summary the other statuses still get;
 *                             serverId only shows up if the order actually
 *                             has one. No receipt/photo is ever attached to
 *                             this DM — that only happens at order-creation
 *                             time. Also triggers maybeSendLowBalanceAlert():
 *                             a follow-up DM if the customer's wallet balance
 *                             is now under LOW_BALANCE_THRESHOLD (5,000 MMK).
 *
 * /auth/* return: { token: "<firebase custom token>", user: { id, first_name, ... } }
 * The client then calls: signInWithCustomToken(auth, token)
 *
 * Firebase UID used: `tg_<telegram_user_id>` — keep this format in mind when
 * writing Firestore security rules / matching against existing guest data.
 *
 * Required secrets (wrangler secret put ...):
 *   TELEGRAM_BOT_TOKEN     - linngamestorebot's bot token (NOT the order bot's)
 *   FIREBASE_PRIVATE_KEY   - service account private key (PEM, \n-escaped is fine)
 *   FIREBASE_CLIENT_EMAIL  - service account client email (used both to mint
 *                            custom tokens AND, for /telegram-webhook, to get
 *                            an OAuth2 access token for read-only Firestore
 *                            REST calls — the service account needs a role
 *                            that can read Firestore, e.g. Cloud Datastore
 *                            User / Firebase Admin)
 *   ADMIN_BROADCAST_SECRET - OPTIONAL fallback only. The live value is read
 *                            from Firestore's settings/adminBroadcast.secret
 *                            (see getAdminBroadcastSecret()) so it can be
 *                            set/rotated from admin.html's Settings page
 *                            without redeploying or touching wrangler/the
 *                            Cloudflare dashboard. This env var is only used
 *                            if that Firestore doc has no `secret` set yet.
 *   TELEGRAM_WEBHOOK_SECRET - OPTIONAL but strongly recommended. Any random
 *                            string (e.g. `openssl rand -hex 32`). Locks
 *                            /telegram-webhook down to requests that actually
 *                            came from Telegram — set it, then register it
 *                            with Telegram by adding &secret_token=<value> to
 *                            the setWebhook URL below. REQUIRED in practice: if
 *                            unset, every update is rejected (fails closed).
 *   ADMIN_TELEGRAM_CHAT_ID - OPTIONAL. The admin's own Telegram chat id (for
 *                            a 1:1 bot chat this is just their Telegram user
 *                            id). If set, the Worker DMs that chat a 🚨 alert
 *                            when an unhandled request error or a wallet-topup
 *                            receipt failure happens — see alertAdmin(), which
 *                            retries the Telegram send itself (honoring a 429's
 *                            retry_after) up to 3 times before giving up, so a
 *                            momentary Telegram API hiccup doesn't silently
 *                            drop the alert. If unset, this is a silent no-op.
 *                            The topup-submit rate limit (5/hour/customer,
 *                            checkRateLimit()) now also tells the customer a
 *                            concrete "try again in ~N minutes" instead of a
 *                            vague "please wait".
 *
 * CORS: locked to your storefront origin(s) below — edit ALLOWED_ORIGINS.
 */

const ALLOWED_ORIGINS = [
  'https://linngamestore.com',
  'https://www.linngamestore.com',
];

const FIREBASE_AUD =
  'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const corsHeaders = buildCorsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      if (request.method === 'POST' && url.pathname === '/auth/miniapp') {
        return await handleMiniApp(request, env, corsHeaders, ctx);
      }
      if (request.method === 'POST' && url.pathname === '/auth/widget') {
        return await handleWidget(request, env, corsHeaders, ctx);
      }
      if (request.method === 'POST' && url.pathname === '/notify-connected') {
        return await handleNotifyConnected(request, env, corsHeaders);
      }
      if (request.method === 'POST' && url.pathname === '/admin/broadcast') {
        return await handleAdminBroadcast(request, env, ctx, corsHeaders);
      }
      if (request.method === 'POST' && url.pathname === '/admin/notify-user') {
        return await handleAdminNotifyUser(request, env, corsHeaders);
      }
      if (request.method === 'POST' && url.pathname === '/notify-order-status') {
        return await handleOrderStatusNotify(request, env, corsHeaders);
      }
      if (request.method === 'POST' && url.pathname === '/notify-wallet-warning') {
        return await handleWalletWarningNotify(request, env, corsHeaders);
      }
      if (request.method === 'POST' && url.pathname === '/notify-topup-status') {
        return await handleTopupStatusNotify(request, env, corsHeaders);
      }
      if (request.method === 'POST' && url.pathname === '/telegram-webhook') {
        return await handleTelegramWebhook(request, env, ctx);
      }
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true }, 200, corsHeaders);
      }
      return json({ error: 'Not found' }, 404, corsHeaders);
    } catch (err) {
      console.error('auth-worker error:', err);
      if (ctx) ctx.waitUntil(alertAdmin(env, `${request.method} ${url.pathname} threw`, err));
      return json({ error: 'Internal error' }, 500, corsHeaders);
    }
  },

  // Cron entry point for the wallet-topup session-timeout warning (see
  // warnExpiringTopupSessions() below) and the actual auto-cancel + "Session
  // Expired" DM (see expireStaleTopupSessions() below). Requires a Cron
  // Trigger added to wrangler.toml, e.g.:
  //   [triggers]
  //   crons = ["*/2 * * * *"]
  // Every 2 minutes gives comfortable coverage for a "2 minutes left"
  // warning and a prompt auto-cancel against the 12-minute
  // SESSION_TIMEOUT_MS. Without a Cron Trigger configured, this export is
  // simply never invoked — no other behavior in the file depends on it (a
  // session left with no cron running just sits until getBotSession()'s own
  // lazy check clears it next time that customer messages the bot, with no
  // "Session Expired" DM sent).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(warnExpiringTopupSessions(env, ctx));
    ctx.waitUntil(expireStaleTopupSessions(env, ctx));
    ctx.waitUntil(refreshLiveBuyCards(env));   // open price lists follow store price changes (every cron tick)
  },
};

// ---------------------------------------------------------------------------
// Mini App login — verifies Telegram WebApp initData
// ---------------------------------------------------------------------------
async function handleMiniApp(request, env, corsHeaders, ctx) {
  const body = await safeJson(request);
  const initData = body && body.initData;
  if (!initData || typeof initData !== 'string') {
    return json({ error: 'Missing initData' }, 400, corsHeaders);
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return json({ error: 'Missing hash' }, 400, corsHeaders);
  params.delete('hash');

  // auth_date freshness check (reject initData older than 24h)
  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (!authDate || Date.now() / 1000 - authDate > 86400) {
    return json({ error: 'initData expired' }, 401, corsHeaders);
  }

  const dataCheckString = buildDataCheckString(params);

  // secret_key = HMAC_SHA256(key="WebAppData", data=bot_token)
  const secretKey = await hmacSha256Raw(
    strToBuf('WebAppData'),
    strToBuf(env.TELEGRAM_BOT_TOKEN)
  );
  const computedHash = await hmacSha256Hex(secretKey, strToBuf(dataCheckString));

  if (!timingSafeEqualHex(computedHash, hash)) {
    return json({ error: 'Invalid hash' }, 401, corsHeaders);
  }

  const userRaw = params.get('user');
  if (!userRaw) return json({ error: 'Missing user in initData' }, 400, corsHeaders);
  const tgUser = JSON.parse(userRaw);
  if (ctx) ctx.waitUntil(notifyAdminNewTelegramUser(env, tgUser, 'Mini App'));

  // initData is verified above, so tgUser.id is PROVEN. Link it to this device's
  // guest account (if there is real evidence it belongs to them) BEFORE the
  // Firebase token is used, so Wallet works right after login.
  await autoLinkTelegramGuest(env, tgUser, body.guestId);
  if (ctx) ctx.waitUntil(sendLoginWelcome(env, tgUser));

  const token = await mintFirebaseToken(env, tgUser);
  return json({ token, user: tgUser }, 200, corsHeaders);
}

// ---------------------------------------------------------------------------
// Login Widget login — verifies the classic Telegram Login Widget payload
// ---------------------------------------------------------------------------
async function handleWidget(request, env, corsHeaders, ctx) {
  const body = await safeJson(request);
  if (!body || !body.id || !body.hash || !body.auth_date) {
    return json({ error: 'Missing widget fields' }, 400, corsHeaders);
  }

  // guestId is added by the store; it is NOT part of Telegram's signed payload.
  const { hash, guestId: widgetGuestId, ...rest } = body;

  const authDate = parseInt(rest.auth_date, 10);
  if (!authDate || Date.now() / 1000 - authDate > 3600) { // widget payload is created at tap time: 1 h is plenty (was 24 h)
    return json({ error: 'Login expired' }, 401, corsHeaders);
  }

  const dataCheckString = Object.keys(rest)
    .filter((k) => rest[k] !== undefined && rest[k] !== null)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('\n');

  // secret_key = SHA256(bot_token)  (raw digest bytes, used as HMAC key)
  const secretKey = await sha256Raw(strToBuf(env.TELEGRAM_BOT_TOKEN));
  const computedHash = await hmacSha256Hex(secretKey, strToBuf(dataCheckString));

  if (!timingSafeEqualHex(computedHash, hash)) {
    return json({ error: 'Invalid hash' }, 401, corsHeaders);
  }

  const tgUser = {
    id: rest.id,
    first_name: rest.first_name,
    last_name: rest.last_name,
    username: rest.username,
    photo_url: rest.photo_url,
  };
  if (ctx) ctx.waitUntil(notifyAdminNewTelegramUser(env, tgUser, 'Login Widget'));

  await autoLinkTelegramGuest(env, tgUser, widgetGuestId);
  if (ctx) ctx.waitUntil(sendLoginWelcome(env, tgUser));

  const token = await mintFirebaseToken(env, tgUser);
  return json({ token, user: tgUser }, 200, corsHeaders);
}

// ---------------------------------------------------------------------------
// Auto-link a verified Telegram login to the guest account on this device.
//
// Why: wallet ownership = users/{guestId}.authUid == 'tg_<id>' (see
// firestore.rules). The browser can't claim a guest doc that already holds
// money, so an account with a balance stayed "not yours" and Wallet purchases
// failed with permission-denied. This runs with the service account, but ONLY
// when there is real evidence the guest belongs to this Telegram id:
//   (a) telegramAccounts/tg_<id> already points at this guestId (that link doc
//       could only be created by the real owner), or
//   (b) users/{guestId}.telegramId equals the verified Telegram id.
// Never overrides an authUid that belongs to someone else, never moves an
// existing link to a different guest. Best-effort: login never fails because of it.
// ---------------------------------------------------------------------------
async function fsGetFields(env, docPath) {
  const token = await getFirestoreAccessToken(env);
  const projectId = firestoreProjectId(env);
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const res = await fetch(`${base}/${docPath}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Firestore read failed: ' + res.status);
  const doc = await res.json();
  return doc.fields || {};
}

// Find every users/* doc whose telegramId equals this VERIFIED Telegram id
// (service account -> bypasses rules). Lets a Telegram login find its account
// on ANY device, without the browser having to prove anything.
async function fsFindGuestsByTelegramId(env, tgId) {
  const token = await getFirestoreAccessToken(env);
  const projectId = firestoreProjectId(env);
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'users' }],
        where: { fieldFilter: { field: { fieldPath: 'telegramId' }, op: 'EQUAL', value: { stringValue: tgId } } },
        limit: 3,
      },
    }),
  });
  if (!res.ok) return [];
  const rows = await res.json();
  return rows.filter((r) => r.document).map((r) => r.document.name.split('/').pop());
}

// Make `uid` (tg_<id>) the owner of users/{guestId} if nobody else owns it.
async function claimGuestForTelegram(env, guestId, uid, tgId) {
  const userF = await fsGetFields(env, `users/${guestId}`);
  if (!userF) return false;
  const ownerUid = fsField(userF, 'authUid') || '';
  if (ownerUid && ownerUid !== uid) return false;           // owned by another login
  const recordedTg = String(fsField(userF, 'telegramId') || '');
  if (recordedTg && recordedTg !== tgId) return false;      // belongs to another Telegram id
  const patch = {};
  if (!ownerUid) patch.authUid = uid;
  if (!recordedTg) patch.telegramId = tgId;
  if (Object.keys(patch).length) await fsMergeDoc(env, `users/${guestId}`, patch);
  return true;
}

async function autoLinkTelegramGuest(env, tgUser, guestId) {
  try {
    if (!tgUser || !tgUser.id) return;
    const tgId = String(tgUser.id);
    const uid = 'tg_' + tgId;

    // (1) Link doc already exists -> make sure the user doc really has authUid.
    const linkF = await fsGetFields(env, `telegramAccounts/${uid}`);
    if (linkF) {
      const linked = fsField(linkF, 'guestId');
      if (linked) await claimGuestForTelegram(env, linked, uid, tgId);
      return; // store.html switches the device over to `linked` if it differs
    }

    // (2) A user doc already records this verified Telegram id (e.g. saved when
    //     the account was created / by admin) -> that IS this person's account,
    //     on whatever device they log in from.
    const known = await fsFindGuestsByTelegramId(env, tgId);
    if (known.length === 1) {
      // SECURITY: users.telegramId is writable by whoever owns that doc, so it is NOT proof by itself.
      // Never hand a doc that another login (Google / Facebook / e-mail) already owns to this Telegram id -
      // otherwise someone could write a victim's telegramId on their own wallet and trap the victim in it.
      const kf = await fsGetFields(env, `users/${known[0]}`);
      if (kf && (fsField(kf, 'googleEmail') || fsField(kf, 'facebookEmail') || fsField(kf, 'emailAuthUid'))) return;
      if (await claimGuestForTelegram(env, known[0], uid, tgId)) {
        await fsSetDoc(env, `telegramAccounts/${uid}`, { guestId: known[0], telegramId: tgId, linkedAt: new Date() });
      }
      return;
    }
    if (known.length > 1) return; // ambiguous -> never guess with money involved

    // (3) Nothing recorded yet: adopt this device's guest doc ONLY if it is
    //     unclaimed and empty (same safety rule firestore.rules uses).
    if (typeof guestId !== 'string' || !/^[A-Za-z0-9_-]{3,64}$/.test(guestId)) return;
    const userF = await fsGetFields(env, `users/${guestId}`);
    if (!userF) return; // brand-new guest: the store's normal first-link flow handles it
    const unclaimed = !fsField(userF, 'authUid') && !fsField(userF, 'googleEmail')
      && !fsField(userF, 'facebookEmail') && !fsField(userF, 'emailAuthUid')
      && !(Number(fsField(userF, 'walletBalance') || 0) > 0)
      && !fsField(userF, 'telegramId');
    if (!unclaimed) return;
    await fsSetDoc(env, `telegramAccounts/${uid}`, { guestId, telegramId: tgId, linkedAt: new Date() });
    await fsMergeDoc(env, `users/${guestId}`, { authUid: uid, telegramId: tgId });
  } catch (e) {
    console.error('autoLinkTelegramGuest failed:', e);
  }
}

// ---------------------------------------------------------------------------
// New Telegram user -> admin alert. Fires from /auth/miniapp and /auth/widget
// the first time a Telegram id logs in (no telegramAccounts/tg_<id> link doc
// yet). Only Telegram logins ever reach this Worker, so Google/Email signups
// are never reported and no email is included. Sent ONCE per Telegram id: an
// atomic create of telegramNewLoginAlerts/<id> claims it, so re-logins and
// retries never re-alert. Goes to env.ADMIN_TELEGRAM_CHAT_ID (comma-separate
// several) through linngamestorebot — the admin must have pressed /start in
// that bot once (same requirement as alertAdmin()). Best-effort: never blocks
// or fails the login itself.
// ---------------------------------------------------------------------------
async function notifyAdminNewTelegramUser(env, tgUser, source) {
  try {
    if (!env.ADMIN_TELEGRAM_CHAT_ID || !tgUser || !tgUser.id) return;

    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const linkRes = await fetch(`${base}/telegramAccounts/tg_${tgUser.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (linkRes.status !== 404) return; // already linked (or lookup failed) -> not a new user

    const firstTime = await fsCreateDocOnce(env, 'telegramNewLoginAlerts', String(tgUser.id), {
      telegramId: String(tgUser.id),
      createdAt: new Date(),
    });
    if (!firstTime) return;

    const fullName = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || '-';
    const time = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Yangon', hour12: false }) + ' (Yangon)';
    const lines = [
      '🆕 New Telegram User',
      '',
      `👤 Account Name: ${fullName}`,
      `🔖 Username: ${tgUser.username ? '@' + tgUser.username : '-'}`,
      `🆔 Telegram ID: ${tgUser.id}`,
      `💬 Chat ID: ${tgUser.id}`,
      tgUser.language_code ? `🌐 Language: ${tgUser.language_code}` : null,
      tgUser.is_premium ? '⭐ Premium: Yes' : null,
      tgUser.username ? `🔗 https://t.me/${tgUser.username}` : null,
      `📲 Login via: ${source}`,
      `🕐 ${time}`,
    ].filter((l) => l !== null);
    const text = lines.join('\n');

    const adminIds = String(env.ADMIN_TELEGRAM_CHAT_ID).split(',').map((x) => x.trim()).filter(Boolean);
    for (const adminId of adminIds) await sendTelegramMessage(env, adminId, text);
  } catch (e) {
    console.error('notifyAdminNewTelegramUser failed:', e);
  }
}

// Atomic "create only if absent" — Firestore returns 409 ALREADY_EXISTS for a
// duplicate documentId, so two concurrent logins can't both win. Returns true
// only for the caller that actually created the doc.
async function fsCreateDocOnce(env, collectionPath, docId, data) {
  const token = await getFirestoreAccessToken(env);
  const projectId = firestoreProjectId(env);
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const res = await fetch(`${base}/${collectionPath}?documentId=${encodeURIComponent(docId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: toFsFields(data) }),
  });
  return res.ok;
}

// ---------------------------------------------------------------------------
// Customer bot menu (linngamestorebot) — /start + a persistent reply
// keyboard designed specifically for Linn Game Store.
// "Account connected! Hi <name>." pattern. Reads live data straight from
// Firestore via a Google OAuth2 (service-account) token, reusing the same
// FIREBASE_PRIVATE_KEY / FIREBASE_CLIENT_EMAIL secrets already used to mint
// custom tokens. Set the webhook once after deploy:
//   https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<this-worker-url>/telegram-webhook
// ---------------------------------------------------------------------------
const STORE_URL = 'https://linngamestore.com';
const WALLET_TOPUP_MIN = 5000;
const WALLET_TOPUP_MAX = 10000000;
// A Top Up flow (amount -> method -> receipt) left mid-way after this long
// is treated as abandoned and auto-cleared, so a stray photo or number sent
// hours/days later doesn't get mistaken for the old flow's next step. Kept
// at 12 minutes (inside the requested 10-15 min window) rather than the old
// 20 — a stale session hanging around that long was letting abandoned
// customers pile up.
const SESSION_TIMEOUT_MS = 12 * 60 * 1000; // 12 minutes

// Preset amounts shown as quick-tap buttons on the "enter amount" step, so a
// customer doesn't have to type a number for a common top-up size. Edit this
// list to change the presets — quickAmountKeyboard() below pages through it
// automatically (QUICK_TOPUP_PAGE_SIZE per screen, with Next/Back), nothing
// else needs to change.
const QUICK_TOPUP_AMOUNTS = [
  5000, 10000, 20000, 50000,
  100000, 150000, 200000, 250000, 300000, 350000, 400000, 450000, 500000,
  550000, 600000, 650000, 700000, 750000, 800000, 850000, 900000, 950000, 1000000,
];
// 2x2 grid per page ("လေးကွက်") — keeps the keyboard compact on a phone
// screen while still surfacing every preset via Next/Back.
const QUICK_TOPUP_PAGE_SIZE = 4;

// Flow-action button labels, Burmese / English. Navigation names (Wallet, My
// Orders, Top Up Wallet, Help Center, FAQ, Track my order, Contact Support)
// deliberately stay in English in both languages: the Burmese copy refers to
// them by those names, and the bottom reply keyboard must be identical in
// every language (it persists on screen until replaced).
const BTN = {
  cancel:       { my: '❌ ပယ်ဖျက်မည်',      en: '❌ Cancel' },
  confirm:      { my: '✅ အတည်ပြုမည်',      en: '✅ Confirm' },
  edit:         { my: '✏️ ပြင်မည်',         en: '✏️ Edit' },
  changeAmount: { my: '🔢 ပမာဏ ပြောင်း',    en: '🔢 Change amount' },
  copyNumber:   { my: '📋 ဖုန်းနံပါတ် Copy',  en: '📋 Copy number' },
  copyAmount:   { my: '📋 ပမာဏ Copy',        en: '📋 Copy amount' },
  copyOrderId:  { my: '📋 Order ID Copy',     en: '📋 Copy Order ID' },
  changeMethod: { my: '💳 နည်းလမ်း ပြောင်း', en: '💳 Change method' },
  retry:        { my: '🔄 ထပ်ကြိုးစားမည်',   en: '🔄 Try again' },
  next:         { my: '➡️ နောက်ထပ်',        en: '➡️ Next' },
  prev:         { my: '⬅️ နောက်ပြန်',       en: '⬅️ Back' },
  faqList:      { my: '⬅️ FAQ စာရင်း',      en: '⬅️ FAQ List' },
};
function btn(lang, key) {
  const e = BTN[key];
  return (e && (e[lang] || e.my)) || key;
}

// ---------------------------------------------------------------------------
// Button colours (Bot API 9.4 `style`): 'success' = green, 'danger' = red,
// 'primary' = blue. No style = the chat theme's own colour (purple in the
// Linn theme). Telegram has no other colours, so purple is simply "leave it
// unstyled". Used sparingly so the menu does not turn into a rainbow:
//   green = go / confirm / success     red = cancel / fail     blue = in-progress / info
// ---------------------------------------------------------------------------
function styled(button, style) {
  return style ? { ...button, style } : button;
}

// Order status -> button colour. Success = green, Fail = red,
// Pending / Processing (and anything unknown) = blue.
function orderStatusKind(status) {
  const norm = (status || '').trim().toLowerCase();
  if (norm === 'success' || norm === 'completed' || norm === 'delivered') return 'success';
  if (norm === 'fail' || norm === 'failed' || norm === 'rejected') return 'fail';
  return 'progress';
}
function orderButtonStyle(status) {
  const k = orderStatusKind(status);
  return k === 'success' ? 'success' : k === 'fail' ? 'danger' : 'primary';
}
function orderStatusWord(status) {
  const k = orderStatusKind(status);
  if (k === 'success') return 'Success';
  if (k === 'fail') return 'Fail';
  const norm = (status || '').trim().toLowerCase();
  return norm === 'processing' ? 'Processing' : norm === 'pending' ? 'Pending' : (status || '-');
}

// ---------------------------------------------------------------------------
// Bubble width lock. Telegram draws inline buttons exactly as wide as the
// message bubble above them, and the bubble is only as wide as its longest
// line — so a short message ("Wallet: 30,008 MMK") gives a narrow bubble and
// cramped / truncated buttons, while a long line makes everything wide. This
// pads the FIRST line with invisible Braille-blank characters (U+2800, which
// Telegram does not trim) until the message is at least BUBBLE_MIN_WIDTH
// "characters" wide, so bubble and buttons always line up the same way.
// Raise BUBBLE_MIN_WIDTH for wider bubbles, lower it for narrower ones.
// ---------------------------------------------------------------------------
const BUBBLE_MIN_WIDTH = 34;
const BRAILLE_BLANK = '\u2800';
function visualWidth(line) {
  let w = 0;
  for (const ch of String(line).replace(Q_MARKER_RE, '')) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x102b && cp <= 0x103e) continue;                  // Burmese vowel signs / medials (combining)
    if (cp === 0x1036 || cp === 0x1037 || cp === 0x1038) continue;
    if (cp >= 0x1f000 || (cp >= 0x2600 && cp <= 0x27bf)) { w += 2; continue; } // emoji
    w += 1;
  }
  return w;
}
function padBubble(text, minWidth = BUBBLE_MIN_WIDTH) {
  const lines = String(text).split('\n');
  const widest = Math.max(...lines.map(visualWidth));
  if (widest >= minWidth) return text;
  lines[0] += BRAILLE_BLANK.repeat(minWidth - visualWidth(lines[0]));
  return lines.join('\n');
}

// Even button rows. Buttons inside a rich message are drawn as pills exactly as wide as their label, so rows of
// different label lengths (or 1 / 2 / 3 buttons per row) look ragged. evenRows() pads labels with invisible Braille
// blanks so that (a) every button in a row is the same width and (b) every row has about the same total width
// (a lone "Back" matches a 2-column row, "Prev | 1/3 | Next" lines up with the grid above it). Rows that are already
// wider than the common width (long game names) are left alone, nothing is ever shortened. Labels only: callbacks,
// styles and URLs are untouched, and the classic (non-rich) keyboard is never padded.
const EVEN_ROW_CAP = 40;
function evenRows(rows) {
  const ok = (Array.isArray(rows) ? rows : []).filter((r) => Array.isArray(r) && r.length);
  if (!ok.length) return rows;
  const rowW = (r) => Math.max(...r.slice(0, 8).map((b) => visualWidth((b && b.text) || '')));
  let total = 0;
  for (const r of ok) { const t = r.slice(0, 8).length * rowW(r); if (t <= EVEN_ROW_CAP) total = Math.max(total, t); }
  return rows.map((r) => {
    if (!Array.isArray(r) || !r.length) return r;
    const n = Math.min(r.length, 8);
    const w = Math.max(rowW(r), Math.floor(total / n));
    return r.map((b, i) => {
      if (i >= n || !b || typeof b.text !== 'string') return b;
      const gap = w - visualWidth(b.text);
      if (gap <= 0) return b;
      const l = Math.floor(gap / 2);
      return { ...b, text: BRAILLE_BLANK.repeat(l) + b.text + BRAILLE_BLANK.repeat(gap - l) };
    });
  });
}

// Main menu = persistent REPLY keyboard (bottom of the chat, 2 buttons per row, always the same
// size). Nothing menu-related is attached under messages any more. The one exception is
// "Top Up Wallet": it is an inline button that only appears under the Wallet balance message
// (TOPUP_INLINE below). Official Mini App is a web_app keyboard button.
const MAIN_KEYBOARD = {
  keyboard: [
    [styled({ text: 'Start' }, 'success'), styled({ text: 'Game List' }, 'primary')],
    [{ text: 'Wallet' }, { text: 'My Orders' }],
    [{ text: 'My Account' }, { text: 'Help Center' }],
    [{ text: 'Language' }, styled({ text: 'Official Mini App', web_app: { url: STORE_URL } }, 'primary')],
  ],
  resize_keyboard: true,
  is_persistent: true,
};
const TOPUP_INLINE = {
  inline_keyboard: [[styled({ text: 'Top Up Wallet', callback_data: 'menu:Top Up Wallet' }, 'success')]],
};

// ---------------------------------------------------------------------------
// Keyboard auto-refresh. A reply keyboard only changes when the bot sends a message carrying a new one, so after a
// bot update (or for someone who never pressed Start) customers used to have to send /start. KEYBOARD_VERSION is a hash
// of MAIN_KEYBOARD itself, so ANY change to the menu above is picked up automatically: the next time a customer taps
// anything (or logs in on the website) one short message re-sends the current keyboard, once per customer per version.
// State lives in telegramKbState/{telegramId}; _kbSeen avoids a Firestore read on every update inside one isolate.
// ---------------------------------------------------------------------------
function kbHash(str) { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
const KEYBOARD_VERSION = kbHash(JSON.stringify(MAIN_KEYBOARD));
const KB_REFRESH_TEXT = '🔄 Menu အသစ် ပြင်ဆင်ပြီးပါပြီ\nMenu updated';
const _kbSeen = new Map();
async function kbMarkCurrent(env, telegramId) {
  _kbSeen.set(String(telegramId), KEYBOARD_VERSION);
  try { await fsSetDoc(env, `telegramKbState/${telegramId}`, { v: KEYBOARD_VERSION, at: Date.now() }); } catch (e) { console.error('kbMarkCurrent failed:', e); }
}
async function kbIsCurrent(env, telegramId) {
  const id = String(telegramId);
  if (_kbSeen.get(id) === KEYBOARD_VERSION) return true;
  try {
    const f = await fsGetFields(env, `telegramKbState/${id}`);
    if (f && fsField(f, 'v') === KEYBOARD_VERSION) { _kbSeen.set(id, KEYBOARD_VERSION); return true; }
  } catch (e) { console.error('kbIsCurrent failed:', e); return true; }   // on a read error do nothing rather than spam
  return false;
}
async function ensureKeyboard(env, update) {
  try {
    const msg = update && update.message, cq = update && update.callback_query;
    const from = (msg && msg.from) || (cq && cq.from);
    const chat = msg ? msg.chat : (cq && cq.message && cq.message.chat);
    if (!from || !chat || chat.type !== 'private') return;
    if (msg && msg.text && (/^\/(start|menu)\b/i.test(msg.text) || normalizeMenuText(msg.text) === 'Start')) { await kbMarkCurrent(env, from.id); return; }   // /start sends the keyboard itself
    if (await kbIsCurrent(env, from.id)) return;
    await sendTelegramMessage(env, chat.id, KB_REFRESH_TEXT, MAIN_KEYBOARD);
    await kbMarkCurrent(env, from.id);
  } catch (e) { console.error('ensureKeyboard failed:', e); }
}
// Website login (Mini App / Login Widget): if this customer's keyboard is missing / outdated and the account is already
// linked, send the welcome + account details WITH the keyboard right away - no /start needed. A first-ever link is
// covered by /notify-connected (which also marks the keyboard current).
async function sendLoginWelcome(env, tgUser) {
  try {
    const id = tgUser && tgUser.id;
    if (!id || await kbIsCurrent(env, id)) return;
    const acct = await lookupAccountByTelegramId(env, id);
    if (!acct) return;
    const lang = await getLanguage(env, String(id));
    const name = acct.name || tgUser.first_name || 'Player';
    await sendTelegramMessage(env, id, t(lang, 'welcomeBack', name), MAIN_KEYBOARD);
    await kbMarkCurrent(env, id);
    await sendMyAccount(env, id, acct, tgUser, lang);
  } catch (e) { console.error('sendLoginWelcome failed:', e); }
}

// The wallet top-up flow's amount step now keeps MAIN_KEYBOARD on screen
// (it used to hide it with remove_keyboard, but that meant the only way
// out was typing /cancel — see cancelInlineKeyboard()/topup_cancel below).
// With the menu buttons visible again, a tap on any of them arrives here
// as plain text while session.step is still 'awaiting_amount', which
// would otherwise be mistaken for an invalid amount. Recognize those
// texts and silently drop the stale topup session instead of blocking
// the tap with a confusing "ပမာဏကို ဂဏန်းနဲ့ ရိုက်ထည့်ပါ" reply.
const MAIN_MENU_TEXTS = new Set([
  // Compared via normalizeMenuText() (emoji stripped) — see there.
  'Start', 'Game List', 'Wallet', 'My Orders',
  'My Account', 'Top Up Wallet', 'Help Center', 'Language',
  '/start', '/menu', '/help', '/language',
]);

// ---------------------------------------------------------------------------
// Premium (custom) emoji on inline buttons — the same look as G2BulkBot's
// "Contact Support" / "Visit Support Channel" buttons (Bot API 9.4
// icon_custom_emoji_id). Fill in BUTTON_ICONS below with the custom emoji IDs
// the client wants; an empty string = keep the normal button as-is.
//
// Key = a button's callback_data (exact) OR its exact label text.
// Telegram only accepts icon_custom_emoji_id if the BOT OWNER's Telegram
// account has Premium (or the bot has a Fragment-purchased username). If
// Telegram rejects the message we automatically re-send with the plain
// emoji buttons (see sendTelegramMessage/editTelegramMessage), so a missing
// Premium subscription can never break a menu.
// Get an ID: forward a premium emoji to @RawDataBot / @getidsbot, or read
// custom_emoji_id from the entities of a message that contains it.
// ---------------------------------------------------------------------------
const BUTTON_ICONS = {
  'topup_cancel': '',            // ❌ Cancel
  'topup_confirm': '',           // ✅ Confirm
  'topup_edit': '',              // ✏️ Edit
  'topup_back_amount': '',       // 🔙 Change Amount
  'topup_back_method': '',       // 🔙 Change Method
  'topup_retry_receipt': '',     // 🔄 Retry
  'faq:list': '',                // ❓ FAQ
  'track:start': '',             // 🔍 Track my order
  '💬 Contact Support': '',      // Help Center support button
  '🚀 Open Linn Game Store': '', // web-app button
  // Main reply keyboard (bottom of the chat) — same keys as the button labels:
  // (the keyboard labels carry no emoji, so the keys are the plain labels —
  //  /seticon Wallet <premium emoji> puts the emoji in front of that button)
  'Start': '',
  'Game List': '',
  'Wallet': '',
  'My Orders': '',
  'My Account': '',
  'Top Up Wallet': '',
  'Help Center': '',
  'Language': '',
  'Official Mini App': '',
};

// Leading emoji (+ optional variation selector / space) on a button label —
// stripped when a custom icon replaces it so the button doesn't show two.
const LEADING_EMOJI_RE = /^(?:\p{Extended_Pictographic}\uFE0F?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*)\s*/u;

// Returns a copy of an inline keyboard with icon_custom_emoji_id applied, or
// null when nothing in it has an icon configured (caller then uses the
// original markup untouched).
function withButtonIcons(markup) {
  if (!markup) return null;
  let changed = false;
  const decorate = (btn) => {
    const id = iconForButton(btn.callback_data) || iconForButton(btn.text);
    if (!id) return btn;
    changed = true;
    return { ...btn, text: btn.text.replace(LEADING_EMOJI_RE, ''), icon_custom_emoji_id: id };
  };
  // Inline keyboards (under a message) and the persistent reply keyboard
  // (MAIN_KEYBOARD, at the bottom of the screen) both support the icon.
  if (Array.isArray(markup.inline_keyboard)) {
    const rows = markup.inline_keyboard.map((row) => row.map(decorate));
    return changed ? { ...markup, inline_keyboard: rows } : null;
  }
  if (Array.isArray(markup.keyboard)) {
    const rows = markup.keyboard.map((row) => row.map(decorate));
    return changed ? { ...markup, keyboard: rows } : null;
  }
  return null;
}

// A tapped reply-keyboard button arrives as plain text. With a custom icon
// the label loses its leading emoji ("Game List"), while customers on an old
// keyboard / without icons still send "🎮 Game List" — so menu routing
// compares this normalized form (emoji stripped) and both work.
function normalizeMenuText(text) {
  return String(text || '').replace(LEADING_EMOJI_RE, '').trim();
}

// Inline button labels carry no emoji (colour styles already show intent).
const ANY_EMOJI_RE = /\p{Extended_Pictographic}\uFE0F?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*/gu;
function cleanButtonLabels(markup) {
  if (!markup || !Array.isArray(markup.inline_keyboard)) return markup;
  return {
    ...markup,
    inline_keyboard: markup.inline_keyboard.map((row) =>
      row.map((b) => (b && typeof b.text === 'string' && !b.icon_custom_emoji_id
        ? { ...b, text: (b.text.replace(ANY_EMOJI_RE, '').replace(/\s{2,}/g, ' ').trim() || b.text) }
        : b))
    ),
  };
}

// ---- Bot API 10.3 rich messages: put the inline buttons INSIDE the message ----
// Plain text (+ entities) is turned into paragraph blocks and every inline_keyboard row into a button-row block.
// Any failure (old Telegram, unsupported shape) falls back to the classic message, so nothing is ever lost.

// Telegram-HTML (b/i/u/s/code/a/blockquote/tg-spoiler) -> rich paragraph blocks, one paragraph per line.
// Returns null for anything it can't represent faithfully (<pre>, unknown tags) so the caller keeps the classic message.
const RICH_TAGS = { b: 'bold', strong: 'bold', i: 'italic', em: 'italic', u: 'underline', ins: 'underline', s: 'strikethrough', strike: 'strikethrough', del: 'strikethrough', code: 'code', 'tg-spoiler': 'spoiler' };
function htmlToRichBlocks(html) {
  if (/<pre[\s>]/i.test(html)) return null;
  const dec = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const conv = (n) => {
    const kids = n.arr.map(x => (typeof x === 'string' ? x : conv(x))).filter(x => x !== '' && x !== null);
    const inner = kids.length === 1 ? kids[0] : kids;
    if (!kids.length) return '';
    if (RICH_TAGS[n.tag]) return { type: RICH_TAGS[n.tag], text: inner };
    if (n.tag === 'a') return n.href ? { type: 'url', text: inner, url: n.href } : inner;
    return inner; // blockquote / span
  };
  const blocks = [];
  let carry = [];
  for (const line of html.split('\n')) {
    const root = { tag: '', arr: [] };
    const chain = [root];
    const open = (tag, href) => { const n = { tag, href, arr: [] }; chain[chain.length - 1].arr.push(n); chain.push(n); };
    carry.forEach(c => open(c.tag, c.href));
    const toks = line.match(/<\/?[a-zA-Z][^>]*>|[^<]+|</g) || [];
    for (const tk of toks) {
      if (tk[0] === '<' && tk.length > 1) {
        const m = tk.match(/^<(\/?)([a-zA-Z-]+)([^>]*)>$/);
        if (!m) return null;
        const tag = m[2].toLowerCase();
        if (!(RICH_TAGS[tag] || tag === 'a' || tag === 'blockquote' || tag === 'span')) return null;
        if (m[1]) { if (chain.length > 1 && chain[chain.length - 1].tag === tag) chain.pop(); }
        else {
          const h = m[3].match(/href\s*=\s*"([^"]*)"/i);
          open(tag, h ? dec(h[1]) : '');
        }
      } else chain[chain.length - 1].arr.push(dec(tk));
    }
    carry = chain.slice(1).map(n => ({ tag: n.tag, href: n.href }));
    const out = conv(root);
    if (out !== '' && !(typeof out === 'string' && !out.trim())) blocks.push({ type: 'paragraph', text: out });
  }
  return blocks.length ? blocks : null;
}

const RICH_ENTITY_TYPES = { bold: 'bold', italic: 'italic', underline: 'underline', strikethrough: 'strikethrough', code: 'code', pre: 'code', spoiler: 'spoiler' };
function richLine(line, base, entities) {
  const end = base + line.length;
  const ents = (entities || []).filter(e => RICH_ENTITY_TYPES[e.type] || (e.type === 'text_link' && e.url))
    .filter(e => e.offset < end && e.offset + e.length > base && e.length > 0);
  const cuts = new Set([base, end]);
  ents.forEach(e => { cuts.add(Math.max(base, e.offset)); cuts.add(Math.min(end, e.offset + e.length)); });
  const pts = [...cuts].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    let node = line.slice(a - base, b - base);
    if (!node) continue;
    for (const e of ents) {
      if (e.offset <= a && e.offset + e.length >= b) {
        node = e.type === 'text_link' ? { type: 'url', text: node, url: e.url } : { type: RICH_ENTITY_TYPES[e.type], text: node };
      }
    }
    parts.push(node);
  }
  return parts.length === 1 ? parts[0] : parts;
}
// true = inline buttons are placed INSIDE the message bubble (rich message, like the order card).
// false = classic inline keyboard under the bubble. Any failure falls back to the classic one.
const RICH_INLINE_BUTTONS = true;
function richFromPayload(payload) {
  if (!RICH_INLINE_BUTTONS) return null;
  const rows = payload.reply_markup && payload.reply_markup.inline_keyboard;
  if (!Array.isArray(rows) || !rows.length || typeof payload.text !== 'string' || !payload.text.trim()) return null;
  if (payload.rich_message) return null;
  let blocks = [];
  if (payload.parse_mode) {
    if (String(payload.parse_mode).toLowerCase() !== 'html') return null;
    blocks = htmlToRichBlocks(payload.text);
    if (!blocks) return null;
  } else {
    let pos = 0;
    for (const line of payload.text.split('\n')) {
      if (line.trim()) blocks.push({ type: 'paragraph', text: richLine(line, pos, payload.entities) });
      pos += line.length + 1;
    }
  }
  if (!blocks.length) return null;
  for (const row of evenRows(rows)) {
    if (!Array.isArray(row) || !row.length) continue;
    blocks.push({
      type: 'buttons', align: 'center',
      buttons: row.slice(0, 8).map(b => {
        // RichMessageButton supports `style` (primary/success/danger/link) just like InlineKeyboardButton,
        // so keep it: stripping it made every green/red/blue button come out uncoloured. Only the
        // premium-emoji icon field does not exist on rich buttons.
        const { icon_custom_emoji_id, ...rest } = b || {};
        return rest;
      })
    });
  }
  return blocks;
}

/* ---------- Button spinner ----------
   When a tapped button's work takes longer than ~0.4 s, the button itself turns into a rotating spinner
   ("⠋ Confirm" -> "⠙ Confirm" -> ...) so the user can see the tap was received. The pressed button goes inert
   (callback "spin") while it spins; every other button is left alone. The moment the handler edits or deletes
   that message (the normal case: the new screen replaces the old one) the spinner steps aside; if the handler
   finishes WITHOUT touching the message (error, a toast, a new message instead) the original keyboard is restored.
   Works for classic inline keyboards and for rich messages (buttons inside the message body).
   Private chat: animated. Groups: one static ⏳ frame (Telegram limits how fast a group may be edited). */
const _SPIN = new Map();
const _SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const _SPIN_EDIT = /^(editMessageText|editMessageReplyMarkup|editMessageCaption|editMessageMedia|deleteMessage)$/;
async function spinGuard(method, payload) {            // call at the top of the file's low-level Telegram helper
  if (!_SPIN.size || !payload || !_SPIN_EDIT.test(method)) return;
  const s = _SPIN.get(`${payload.chat_id}:${payload.message_id}`);
  if (s) await s.halt(true);
}
function startButtonSpinner(token, cb, opts = {}) {
  const none = { end: async () => {} };
  try {
    const msg = cb && cb.message;
    if (!token || !msg || !msg.chat || !cb.data || cb.data === "spin" || cb.data === "nop") return none;
    const rich = msg.rich_message && Array.isArray(msg.rich_message.blocks) ? msg.rich_message : null;
    const isBtns = (b) => b && b.type === "buttons" && Array.isArray(b.buttons);
    const kb = rich ? null : msg.reply_markup && msg.reply_markup.inline_keyboard;
    if (rich ? !rich.blocks.some(isBtns) : !Array.isArray(kb)) return none;
    if (rich && rich.blocks.some((b) => b && b.type !== "paragraph" && b.type !== "buttons" && b.type !== "table")) return none;   // photo / media cards are left alone (their blocks cannot be safely re-sent)
    const chat_id = msg.chat.id, message_id = msg.message_id, key = `${chat_id}:${message_id}`;
    if (_SPIN.has(key)) return none;
    const animate = opts.animate !== undefined ? opts.animate : msg.chat.type === "private";
    const delay = opts.delay || 400, every = opts.every || 1100, max = opts.max || 25;
    const frameOf = (n) => (animate ? _SPIN_FRAMES[n % _SPIN_FRAMES.length] : "⏳");
    const mapBtn = (n) => (b) => {
      if (n === null || !b || b.callback_data !== cb.data) return b;
      const label = String(b.text || "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
      return { ...b, text: (frameOf(n) + (label ? " " + label : "")).slice(0, 60), callback_data: "spin" };
    };
    const call = (n) => {                                // n = frame number, or null = put the original buttons back
      const f = mapBtn(n);
      const body = rich
        ? { chat_id, message_id, rich_message: { blocks: rich.blocks.map((b) => (isBtns(b) ? { ...b, buttons: b.buttons.map(f) } : b)) } }
        : { chat_id, message_id, reply_markup: { inline_keyboard: kb.map((row) => row.map(f)) } };
      return fetch(`https://api.telegram.org/bot${token}/${rich ? "editMessageText" : "editMessageReplyMarkup"}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }).then((r) => r.json()).catch(() => null);
    };
    let n = 0, stopped = false, shown = false, replaced = false, timer = null, inflight = Promise.resolve();
    const tick = () => {
      if (stopped) return;
      shown = true;
      inflight = call(n++);
      if (animate && n < max) timer = setTimeout(tick, every);
    };
    timer = setTimeout(tick, delay);
    const self = {
      async halt(byEdit) {
        stopped = true; clearTimeout(timer);
        if (_SPIN.get(key) === self) _SPIN.delete(key);
        if (byEdit) replaced = true;
        await inflight;
      },
      async end() {
        await self.halt(false);
        if (shown && !replaced) await call(null);
      },
    };
    _SPIN.set(key, self);
    return self;
  } catch (e) { return none; }
}

async function tgPost(env, method, payload) {
  await spinGuard(method, payload);   // a spinning button steps aside before its message is edited / deleted
  if (payload && payload.reply_markup) payload = { ...payload, reply_markup: cleanButtonLabels(payload.reply_markup) };
  if (payload && (method === 'sendMessage' || method === 'editMessageText')) {
    try {
      const blocks = richFromPayload(payload);
      if (blocks) {
        const body = { chat_id: payload.chat_id, rich_message: { blocks } };
        if (payload.message_id !== undefined) body.message_id = payload.message_id;
        const rr = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method === 'sendMessage' ? 'sendRichMessage' : 'editMessageText'}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (rr.ok) return rr;
        const info = await rr.clone().json().catch(() => null);
        if (!(info && /not modified/i.test(String(info.description || '')))) console.error('rich send failed, using classic message', info && info.description);
        else return rr;
      }
    } catch (e) { console.error('rich send error', e); }
  }
  return fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// Premium (custom) emoji inside MESSAGE TEXT. Same Premium-owner requirement
// as BUTTON_ICONS above. Key = the normal emoji as it appears in the text
// (write it without the invisible variation selector), value = custom emoji
// ID. Empty string = leave that emoji alone. Every occurrence in any message
// sent/edited through sendTelegramMessage()/editTelegramMessage() is turned
// into a custom_emoji entity — no parse_mode / escaping changes needed, so
// existing texts keep working exactly as before.
// ---------------------------------------------------------------------------
const TEXT_EMOJIS = {
  '✅': '', '❌': '', '➕': '', '💳': '', '⏰': '', '⏳': '', '✨': '',
  '🎮': '', '💼': '', '🛠': '', '📦': '', '👤': '', '💬': '', '🧾': '',
  '💰': '', '🕐': '', '📝': '', '⚡': '', '⭐': '', '🔍': '', '❓': '',
  '🚀': '', '📱': '', '🔙': '', '🔄': '',
};

const TEXT_EMOJI_RE = /\p{Extended_Pictographic}\uFE0F?/gu;

// Builds Telegram "entities" for the emoji in `text` that have an ID above,
// or null when there are none. String indexes in JS are already UTF-16 code
// units, which is what Telegram's offset/length use.
function buildEmojiEntities(text) {
  if (!text) return null;
  const entities = [];
  for (const m of text.matchAll(TEXT_EMOJI_RE)) {
    const id = iconForTextEmoji(m[0].replace(/\uFE0F/g, ''));
    if (id) entities.push({ type: 'custom_emoji', offset: m.index, length: m[0].length, custom_emoji_id: id });
  }
  return entities.length ? entities : null;
}

// ---------------------------------------------------------------------------
// Quote blocks. Message texts are plain (no parse_mode), so a quote is written
// as quoteBlock('...') — it wraps the text in two invisible private-use
// markers, and sendTelegramMessage()/editTelegramMessage()/
// sendBroadcastMessage() turn each marked range into a Telegram "blockquote"
// entity (offsets are UTF-16 units, same as buildEmojiEntities). No HTML
// escaping is involved, so user names / notes inside a quote are safe. If a
// message goes out with parse_mode, the markers are just stripped.
// ---------------------------------------------------------------------------
const Q_OPEN = '\uE000';
const Q_CLOSE = '\uE001';
// Copy markers: copyText('0912345678') -> a Telegram "code" entity (monospace).
// Tapping monospace text in Telegram copies it, so phone / account numbers
// become tap-to-copy without any parse_mode.
const C_OPEN = '\uE002';
const C_CLOSE = '\uE003';
const Q_MARKER_RE = /[\uE000-\uE003]/g;

function quoteBlock(s) {
  return Q_OPEN + s + Q_CLOSE;
}

function copyText(s) {
  return C_OPEN + s + C_CLOSE;
}

function stripQuoteMarkers(text) {
  return text ? text.replace(Q_MARKER_RE, '') : text;
}

// -> { text: <text without markers>, entities: [blockquote entities] }
function extractQuotes(raw) {
  if (!raw) return { text: raw, entities: [] };
  const entities = [];
  let out = '';
  let start = -1;
  let cstart = -1;
  for (const ch of raw) {
    if (ch === Q_OPEN) {
      start = out.length;
    } else if (ch === Q_CLOSE) {
      if (start >= 0 && out.length > start) {
        entities.push({ type: 'blockquote', offset: start, length: out.length - start });
      }
      start = -1;
    } else if (ch === C_OPEN) {
      cstart = out.length;
    } else if (ch === C_CLOSE) {
      if (cstart >= 0 && out.length > cstart) {
        entities.push({ type: 'code', offset: cstart, length: out.length - cstart });
      }
      cstart = -1;
    } else {
      out += ch;
    }
  }
  return { text: out, entities };
}

// Combine emoji + quote entities in the order Telegram expects
// (by offset; the longer/outer one first when offsets tie).
function mergeEntities(a, b) {
  const all = [...(a || []), ...(b || [])];
  if (!all.length) return null;
  return all.sort((x, y) => x.offset - y.offset || y.length - x.length);
}

// Telegram's "message is not modified" is a harmless double-tap, not a sign
// that custom emoji were rejected — everything else with icons/entities
// attached falls back to the plain version.
function shouldFallBackToPlain(data) {
  const desc = (data && data.description) || '';
  return !/not modified/i.test(desc);
}

// ---------------------------------------------------------------------------
// No-Premium behaviour: when Telegram rejects a message because the bot owner
// has no Premium, the message is re-sent WITHOUT the emoji that had a premium
// ID configured (no plain-emoji substitute), and — since that means every
// further attempt would be rejected too — icons are skipped outright for
// ICON_RETRY_MS so we don't pay a failed request on every message. Emoji with
// no premium ID configured are untouched, and the bottom reply keyboard keeps
// its normal emoji (its labels drive menu routing).
// ---------------------------------------------------------------------------
let iconsDisabledUntil = 0;
const ICON_RETRY_MS = 5 * 60 * 1000;
const EMOJI_WITH_SPACE_RE = /\p{Extended_Pictographic}\uFE0F?[ ]?/gu;

function iconsActive() {
  return Date.now() >= iconsDisabledUntil;
}

// Message text minus every emoji that has a premium ID configured.
function stripConfiguredEmojis(text) {
  if (!text) return text;
  return text.replace(EMOJI_WITH_SPACE_RE, (m) => (iconForTextEmoji(m.replace(/[\uFE0F ]/g, '')) ? '' : m));
}

// Inline keyboards: buttons that would get an icon lose their leading
// emoji instead. Reply keyboards are returned unchanged.
function stripIconMarkup(markup) {
  if (!markup || !Array.isArray(markup.inline_keyboard)) return markup;
  return {
    ...markup,
    inline_keyboard: markup.inline_keyboard.map((row) =>
      row.map((btn) => {
        const id = iconForButton(btn.callback_data) || iconForButton(btn.text);
        return id ? { ...btn, text: btn.text.replace(LEADING_EMOJI_RE, '') } : btn;
      })
    ),
  };
}

// ---------------------------------------------------------------------------
// Admin-editable icons — /seticon, /removeicon, /icons (bot admin only, i.e.
// the Telegram id(s) in env.ADMIN_TELEGRAM_CHAT_ID; comma-separate several).
// Overrides live in Firestore "telegramBotConfig/icons" (field "map", a JSON
// string) and take priority over the defaults in BUTTON_ICONS / TEXT_EMOJIS
// above, so changing an icon needs no redeploy. Stored keys are prefixed:
//   "b:<button key>"  — inline/reply button (callback_data or label)
//   "t:<emoji>"       — that emoji wherever it appears in message text
// An empty-string value means "explicitly disabled" (used by /removeicon).
// ---------------------------------------------------------------------------
let ICON_OVERRIDES = {};
let iconOverridesLoadedAt = 0;
const ICON_CACHE_MS = 60 * 1000;

async function loadIconOverrides(env, force) {
  if (!force && Date.now() - iconOverridesLoadedAt < ICON_CACHE_MS) return;
  iconOverridesLoadedAt = Date.now(); // set first so a failing read isn't retried on every message
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const res = await fetch(`${base}/telegramBotConfig/icons`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 404) { ICON_OVERRIDES = {}; return; }
    if (!res.ok) return;
    const doc = await res.json();
    const raw = doc.fields ? fsField(doc.fields, 'map') : '';
    ICON_OVERRIDES = raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error('loadIconOverrides failed:', e);
  }
}

function iconForButton(key) {
  if (!key) return '';
  const o = ICON_OVERRIDES['b:' + key];
  return o !== undefined ? o : BUTTON_ICONS[key] || '';
}

function iconForTextEmoji(emoji) {
  const o = ICON_OVERRIDES['t:' + emoji];
  return o !== undefined ? o : TEXT_EMOJIS[emoji] || '';
}

function isBotAdmin(env, telegramId) {
  const ids = String(env.ADMIN_TELEGRAM_CHAT_ID || '').split(',').map((x) => x.trim()).filter(Boolean);
  return ids.includes(String(telegramId));
}

function isIconCommand(text) {
  return /^\/(seticon|removeicon|icons)(@\w+)?(\s|$)/.test(text || '');
}

// Splits "/seticon <key> <premium emoji | numeric id>" into { cmd, key, id }.
// The key is everything between the command and the emoji, so multi-word keys
// like "Game List" need no quotes. `id` comes from the message's custom_emoji
// entity (Telegram attaches it when the admin types a premium emoji), or from
// a pasted numeric ID at the end.
function parseIconCommand(text, entities) {
  const m = /^\/(seticon|removeicon|icons)(?:@\w+)?/.exec(text);
  if (!m) return null;
  const rest = text.slice(m[0].length);
  const ent = (entities || []).find((e) => e.type === 'custom_emoji');
  let keyPart = rest;
  let id = '';
  if (ent) {
    keyPart = text.slice(m[0].length, ent.offset);
    id = ent.custom_emoji_id;
  } else {
    const idm = /\s(\d{8,})\s*$/.exec(rest);
    if (idm) { id = idm[1]; keyPart = rest.slice(0, idm.index); }
  }
  return { cmd: m[1], key: keyPart.trim(), id };
}

// Maps what the admin typed to a stored override key ("b:…" / "t:…"), or null.
function resolveIconKey(input) {
  if (!input) return null;
  if (/^\p{Extended_Pictographic}\uFE0F?$/u.test(input)) return 't:' + input.replace(/\uFE0F/g, '');
  const want = normalizeMenuText(input).toLowerCase();
  const known = Object.keys(BUTTON_ICONS);
  const hit = known.find((k) => k === input) || known.find((k) => normalizeMenuText(k).toLowerCase() === want);
  return hit ? 'b:' + hit : null;
}

async function saveIconOverrides(env, map) {
  await fsSetDoc(env, 'telegramBotConfig/icons', { map: JSON.stringify(map), updatedAt: new Date() });
  ICON_OVERRIDES = map;
  iconOverridesLoadedAt = Date.now();
  iconsDisabledUntil = 0; // retry icons right away after any change
}

async function handleIconCommand(env, msg) {
  const chatId = msg.chat.id;
  const parsed = parseIconCommand(msg.text || '', msg.entities);
  await loadIconOverrides(env, true);
  const map = { ...ICON_OVERRIDES };

  if (parsed.cmd === 'icons') {
    const lines = [];
    const buttons = Object.keys(BUTTON_ICONS).map((k) => [k, iconForButton(k)]);
    const texts = new Set([...Object.keys(TEXT_EMOJIS), ...Object.keys(map).filter((k) => k.startsWith('t:')).map((k) => k.slice(2))]);
    lines.push('Button icons:');
    buttons.forEach(([k, id]) => lines.push(`• ${k} → ${id || '(မသတ်မှတ်ရသေး)'}`));
    lines.push('', 'Message text emoji (သတ်မှတ်ပြီးသားပဲ):');
    let any = false;
    for (const e of texts) { const id = iconForTextEmoji(e); if (id) { lines.push(`• ${e} → ${id}`); any = true; } }
    if (!any) lines.push('(မရှိသေးပါ)');
    lines.push('', 'သတ်မှတ်ရန်: /seticon <key> <premium emoji>', 'ဖျက်ရန်: /removeicon <key>', 'key = အပေါ်က ခလုတ်နာမည် (ဥပမာ topup_cancel, Game List) (သို့) message ထဲက emoji တစ်ခု (ဥပမာ ✅)');
    return sendTelegramMessage(env, chatId, lines.join('\n'));
  }

  const storeKey = resolveIconKey(parsed.key);
  if (!storeKey) {
    return sendTelegramMessage(env, chatId, `"${parsed.key || ''}" ဆိုတဲ့ key ကို မသိပါ။ /icons ကိုရိုက်ပြီး စာရင်းကြည့်ပါ။`);
  }
  const label = storeKey.slice(2);

  if (parsed.cmd === 'removeicon') {
    map[storeKey] = '';
    await saveIconOverrides(env, map);
    return sendTelegramMessage(env, chatId, `${label} ရဲ့ premium icon ကို ဖျက်လိုက်ပါပြီ။ ပုံမှန် emoji ပြန်သုံးပါမယ်။`);
  }

  // /seticon
  if (!parsed.id) {
    return sendTelegramMessage(env, chatId, 'Premium emoji ကို key နောက်မှာ ထည့်ရိုက်ပါ။ ဥပမာ —\n/seticon topup_cancel <premium emoji>');
  }
  map[storeKey] = parsed.id;
  await saveIconOverrides(env, map);
  return sendTelegramMessage(env, chatId, `${label} အတွက် premium icon သတ်မှတ်ပြီးပါပြီ။ ID: ${parsed.id}\n(Bot ပိုင်ရှင် account မှာ Premium ရှိမှ ပြပါမယ်။ မရှိရင် ပုံမှန် emoji ပဲ ပေါ်ပါမယ်။)`);
}

// ---------------------------------------------------------------------------
// Auto-clean of flow messages. Every message that belongs to a multi-step
// flow (top-up amount prompt, method picker, confirm, receipt prompt, the
// customer's typed amount / receipt photo, "Track order" prompt, warnings…)
// has its message_id recorded in "telegramFlowMsgs/{chatId}". When the flow
// is cancelled (❌ Cancel, /cancel) or expires, all of them are deleted in
// one deleteMessages call, so the chat isn't left with dead buttons.
// chat_id === user id in a 1:1 bot chat (same assumption used elsewhere).
// ---------------------------------------------------------------------------
async function readFlowMessageIds(env, key) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const res = await fetch(`${base}/telegramFlowMsgs/${key}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return [];
    const doc = await res.json();
    const raw = doc.fields ? fsField(doc.fields, 'ids') : '';
    return String(raw || '').split(',').map(Number).filter((n) => n > 0);
  } catch (e) {
    console.error('readFlowMessageIds failed:', e);
    return [];
  }
}

async function trackFlowMessage(env, chatId, messageId) {
  if (!messageId) return;
  try {
    const key = String(chatId);
    const ids = await readFlowMessageIds(env, key);
    if (!ids.includes(messageId)) ids.push(messageId);
    await fsSetDoc(env, `telegramFlowMsgs/${key}`, { ids: ids.slice(-40).join(','), updatedAt: new Date() });
  } catch (e) {
    console.error('trackFlowMessage failed:', e);
  }
}

// Same as sendTelegramMessage(), but remembers the message for auto-clean.
async function sendFlowMessage(env, chatId, text, replyMarkup, parseMode) {
  const id = await sendTelegramMessage(env, chatId, text, replyMarkup, parseMode);
  await trackFlowMessage(env, chatId, id);
  return id;
}

// Deletes every tracked message (plus any extra ids, e.g. the user's own
// "/cancel" or the message the tapped button lives on) and forgets them.
async function deleteFlowMessages(env, chatId, extraIds) {
  try {
    const key = String(chatId);
    const ids = await readFlowMessageIds(env, key);
    for (const x of extraIds || []) if (x && !ids.includes(x)) ids.push(x);
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      try {
        const res = await tgPost(env, 'deleteMessages', { chat_id: chatId, message_ids: chunk });
        if (!res.ok) {
          // Fallback one-by-one (e.g. deleteMessages unavailable / one bad id).
          for (const id of chunk) await tgPost(env, 'deleteMessage', { chat_id: chatId, message_id: id }).catch(() => {});
        }
      } catch (e) {
        console.error('deleteFlowMessages chunk failed:', e);
      }
    }
    await fsDeleteDoc(env, `telegramFlowMsgs/${key}`);
  } catch (e) {
    console.error('deleteFlowMessages failed:', e);
  }
}

// Cancel/expire = wipe the flow's messages, then the session itself.
async function cancelFlow(env, chatId, telegramId, extraIds) {
  await deleteFlowMessages(env, chatId, extraIds);
  await clearBotSession(env, telegramId);
  await buyLiveClear(env, chatId);
}

// Single reusable "❌ Cancel" inline button, attached to every step of the
// wallet top-up flow (amount prompt, payment-method list, receipt prompt)
// so a customer can back out with a tap instead of having to know/type
// /cancel. Routed through the shared 'topup_cancel' callback below.
function cancelInlineKeyboard(extraRows, lang = 'my') {
  return { inline_keyboard: [...(extraRows || []), [styled({ text: btn(lang, 'cancel'), callback_data: 'topup_cancel' }, 'danger')]] };
}

// Same idea as cancelInlineKeyboard(), plus a 2x2 grid (QUICK_TOPUP_PAGE_SIZE)
// of QUICK_TOPUP_AMOUNTS preset buttons for the given page, above a Next/Back
// row and the Cancel button — shown on the "enter amount" step so a customer
// can tap a common amount instead of typing one. Amount buttons route through
// 'topup_qty:<amount>' below; Next/Back re-draw this same message with
// 'topup_qty_page:<page>'.
function quickAmountKeyboard(page = 0, lang = 'my') {
  const totalPages = Math.ceil(QUICK_TOPUP_AMOUNTS.length / QUICK_TOPUP_PAGE_SIZE);
  const clampedPage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = clampedPage * QUICK_TOPUP_PAGE_SIZE;
  const pageAmounts = QUICK_TOPUP_AMOUNTS.slice(start, start + QUICK_TOPUP_PAGE_SIZE);

  const rows = [];
  for (let i = 0; i < pageAmounts.length; i += 2) {
    rows.push(
      pageAmounts.slice(i, i + 2).map((amt) => ({
        text: `${amt.toLocaleString()} MMK`,
        callback_data: `topup_qty:${amt}`,
      }))
    );
  }

  const navRow = [];
  if (clampedPage > 0) navRow.push(styled({ text: btn(lang, 'prev'), callback_data: `topup_qty_page:${clampedPage - 1}` }, 'primary'));
  if (clampedPage < totalPages - 1) navRow.push(styled({ text: btn(lang, 'next'), callback_data: `topup_qty_page:${clampedPage + 1}` }, 'primary'));
  if (navRow.length) rows.push(navRow);

  return cancelInlineKeyboard(rows, lang);
}

// ---------------------------------------------------------------------------
// "🎮 Game List" — in-chat Top Up / Voucher browser.
//
// Tap Game List -> pick "Top Up" or "Voucher" -> pick a genre filter chip
// (All / MOBA / Battle Royale / Survival / Fun / Creative — GAME_GENRES
// below, same ids as index.html's GAME_CATEGORIES) -> a paged list of games
// (grouped by name, same grouping rule store.html uses: two uploads that
// share a name are just different servers/regions of the same game) ->
// tapping a single-server game jumps straight to "Open in App"; tapping a
// multi-server one (e.g. "Mobile Legends (9)") shows its 9 servers first.
// The final "Open in App" button is a web_app inline button pointed at
// "<STORE_URL>?game=<id>" — index.html already has deep-link handling for
// that exact query param (tryOpenPendingPackageDeepLink), so the Mini App
// opens straight into that game's product/package card instead of the
// store's home page.
//
// Entirely stateless: every tap re-reads the "games" collection (+
// settings/providerFlags) from Firestore and recomputes the same
// group/sort/filter the storefront itself uses, so the list always
// reflects whatever the admin panel currently has live and nothing needs
// to be cached in telegramBotSessions for this flow.
// ---------------------------------------------------------------------------
const GAME_LIST_CATEGORIES = { topup: '⚡ Top Up', voucher: '🎁 Voucher / Gift Card' };
const GAME_LIST_PAGE_SIZE = 8;

// Game-genre filter chips, shown after Top Up/Voucher is picked — mirrors
// index.html's GAME_CATEGORIES (same ids, so a game tagged there filters
// correctly here too). Telegram has no colored chip UI, so each genre is
// just an emoji-prefixed inline button instead of an icon+color pill.
const GAME_GENRES = [
  { id: 'moba', label: '🎯 MOBA' },
  { id: 'battle_royale', label: '🚀 Battle Royale' },
  { id: 'survival', label: '🧭 Survival' },
  { id: 'fun', label: '😊 Fun' },
  { id: 'creative', label: '🪶 Creative' },
];
function findGenre(id) { return GAME_GENRES.find((g) => g.id === id); }

// Help Center buttons — one per row, same in every language.
function helpCenterMarkup() {
  return {
    inline_keyboard: [
      [styled({ text: '❓ FAQ', callback_data: 'faq:list' }, 'primary')],
      [styled({ text: '🔍 Track my order', callback_data: 'track:start' }, 'primary')],
      [styled({ text: '💬 Contact Support', url: 'https://t.me/linn270_0' }, 'success')],
    ],
  };
}

function openAppInlineKeyboard() {
  return { inline_keyboard: [[styled({ text: '🚀 Open Linn Game Store', web_app: { url: STORE_URL } }, 'primary')]] };
}

// ---------------------------------------------------------------------------
// MAINTENANCE / KILL SWITCH (customer bot side)
// settings/maintenance is flipped by the order Worker (/maintenance route,
// Telegram "/maintenance on|in|off" command, or admin.html Settings card).
// While enabled, every non-admin chat/callback gets the maintenance text
// instead of the normal bot flow (no top-ups, no purchases). Admins in
// ADMIN_TELEGRAM_CHAT_ID are never blocked. Order-status DMs (/notify-*)
// still go out. Fails OPEN: if Firestore can't be read the bot keeps working.
// ---------------------------------------------------------------------------
let _maintState = { at: 0, v: { enabled: false } };
async function getMaintenanceState(env) {
  const now = Date.now();
  if (now - _maintState.at < 10000) return _maintState.v;
  let v = { enabled: false };
  try {
    const f = await fsGetFields(env, 'settings/maintenance');
    if (f) v = { enabled: fsField(f, 'enabled') === true, reason: fsField(f, 'reason') || '', message: fsField(f, 'message') || '' };
    if (v.enabled) {
      // Same support contact the storefront uses (settings/social.supportTelegram).
      try { const sf = await fsGetFields(env, 'settings/social'); v.support = (sf && fsField(sf, 'supportTelegram') || '').trim(); } catch (e) { /* use default */ }
    }
  } catch (e) {
    console.error('getMaintenanceState failed:', e);
    return _maintState.v; // keep last known
  }
  _maintState = { at: now, v };
  return v;
}

function maintenanceReplyText(m) {
  return m.message || '🔧 Maintenance';
}

async function replyMaintenance(env, update, m) {
  const text = maintenanceReplyText(m);
  const support = String(m.support || 'linn270_0').replace(/^@/, '');
  const markup = { inline_keyboard: [[styled({ text: '💬 Contact Support', url: `https://t.me/${support}` }, 'success')]] };
  if (update.message && update.message.chat) {
    await sendTelegramMessage(env, update.message.chat.id, text, markup);
  } else if (update.callback_query && ANSWERED_CALLBACKS.has(update.callback_query.id)) {
    const cm = update.callback_query.message;
    if (cm && cm.chat) await sendTelegramMessage(env, cm.chat.id, text, markup);
  } else if (update.callback_query) {
    ANSWERED_CALLBACKS.add(update.callback_query.id);
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: update.callback_query.id, text: text.slice(0, 190), show_alert: true }),
    });
  }
  // inline_query: ignored on purpose
}

async function handleTelegramWebhook(request, env, ctx) {
  // Verify this request actually came from Telegram. Set env.TELEGRAM_WEBHOOK_SECRET
  // (any random string, e.g. `openssl rand -hex 32`) then register it once via:
  //   https://api.telegram.org/bot<TOKEN>/setWebhook?url=<this-worker-url>/telegram-webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
  // Telegram echoes it back on every update in the X-Telegram-Bot-Api-Secret-Token
  // header; without this check, anyone who finds the webhook URL can POST fake
  // updates (fake /start, fake wallet topups, etc.) straight into the bot.
  // Fail CLOSED: if the secret is not configured, refuse every update instead of accepting forged ones.
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    console.error('telegram-webhook: TELEGRAM_WEBHOOK_SECRET is not set - rejecting update');
    return json({ ok: true }, 200, { 'Content-Type': 'application/json' });
  }
  {
    const provided = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
    if (!timingSafeEqualStr(provided, env.TELEGRAM_WEBHOOK_SECRET)) {
      console.error('telegram-webhook: bad secret token');
      return json({ ok: true }, 200, { 'Content-Type': 'application/json' });
    }
  }

  const update = await safeJson(request);

  // Button taps: stop the button's loading highlight immediately (before any Firestore work).
  // Only for taps that never show an error popup; skipped while maintenance is known to be on.
  const cqEarly = update && update.callback_query;
  if (cqEarly && INSTANT_CALLBACK_RE.test(cqEarly.data || '') && !(_maintState.v && _maintState.v.enabled && !isBotAdmin(env, cqEarly.from && cqEarly.from.id))) {
    const early = answerCallbackQuery(env, cqEarly.id);
    if (ctx && ctx.waitUntil) ctx.waitUntil(early);
  }

  // Telegram retries a webhook delivery if it doesn't get a fast 200 (cold
  // start, transient error, etc.), which can replay the same update_id —
  // without this, a replayed wallet-topup photo would create a second
  // walletTopups doc for the same payment.
  // The duplicate check and the maintenance lookup don't depend on each other: run them together.
  const senderEarly = update && ((update.message && update.message.from) ||
    (update.callback_query && update.callback_query.from) ||
    (update.inline_query && update.inline_query.from));
  const needMaint = !!(senderEarly && !isBotAdmin(env, senderEarly.id));
  const [isNew, maintState] = await Promise.all([
    update && update.update_id !== undefined ? claimUpdateOnce(env, update.update_id) : Promise.resolve(true),
    needMaint ? getMaintenanceState(env).catch(() => ({ enabled: false })) : Promise.resolve({ enabled: false }),
  ]);
  if (!isNew) return json({ ok: true }, 200, { 'Content-Type': 'application/json' });

  // Kill switch: closed for everyone except bot admins.
  try {
    const sender = senderEarly;
    if (sender && !isBotAdmin(env, sender.id)) {
      const maint = maintState;
      if (maint.enabled) {
        await replyMaintenance(env, update, maint);
        return json({ ok: true }, 200, { 'Content-Type': 'application/json' });
      }
    }
  } catch (e) {
    console.error('maintenance gate failed (continuing normally):', e);
  }

  try {
    const msg = update && update.message;
    if (msg && msg.text) await routeTelegramMessage(env, msg);
    else if (msg && msg.photo) await routeTelegramPhoto(env, msg, ctx);
    else if (update && update.callback_query) {
      const sp = startButtonSpinner(env.TELEGRAM_BOT_TOKEN, update.callback_query);
      try { await routeTelegramCallback(env, update.callback_query, ctx); } finally { await sp.end(); }
    }
    else if (update && update.inline_query) await handleInlineQuery(env, update.inline_query);
    if (ctx && ctx.waitUntil) ctx.waitUntil(ensureKeyboard(env, update));   // outdated / missing keyboard -> refreshed automatically
  } catch (e) {
    console.error('telegram-webhook error:', e);
    if (ctx) ctx.waitUntil(alertAdmin(env, 'telegram-webhook update failed', e));
  }
  // Always 200 — Telegram retries on non-2xx, we never want that for a
  // best-effort bot menu.
  return json({ ok: true }, 200, { 'Content-Type': 'application/json' });
}

// ---------------------------------------------------------------------------
// Bilingual message strings (Burmese default / English opt-in via
// /language or the 🌐 Language button). Covers the menu, Help Center, the
// whole wallet Top Up flow (messages + buttons) and the FAQ essentials.
// Still Burmese-only: Game List browser, order-status push DMs, most FAQ
// answers (add qEn/aEn to an FAQ item to translate it). Add new entries
// here the same way to extend coverage.
// ---------------------------------------------------------------------------
const MESSAGES = {
  cancelled: { my: 'ပယ်ဖျက်လိုက်ပါပြီ။', en: 'Cancelled.' },
  flooded: {
    my: 'ခဏစောင့်ပေးပါ 🙏 Message အရမ်းများနေလို့ ခဏနားပြီးမှ ပြန်ရိုက်ပါ။',
    en: "Please slow down a bit 🙏 That's a lot of messages — try again shortly.",
  },
  welcomeBack: {
    my: (name) => `👋 မင်္ဂလာပါ ${name}\n\n🎮 Linn Game Store မှ ပြန်လည်ကြိုဆိုပါတယ်\nGame Top Up နဲ့ Voucher ကို ဒီ Chat ထဲကနေ ဝယ်လို့ရပါတယ်။\n\n👇 အောက်က Menu ကနေ ရွေးလိုက်ပါ\n\n` + quoteBlock('💡 Game ဝယ်ဖို့ Wallet ထဲမှာ ငွေရှိရပါမယ်။\nမရှိသေးရင် 💼 Wallet → ➕ Top Up Wallet ကနေ အရင်ဖြည့်ပါ။'),
    en: (name) => `👋 Welcome back, ${name}\n\n🎮 Linn Game Store\nYou can buy game top-ups and vouchers right here.\n\n👇 Pick something from the menu below\n\n` + quoteBlock("💡 You'll need money in your Wallet to buy games.\nIf it's empty, open 💼 Wallet → ➕ Top Up Wallet."),
  },
  welcomeNew: {
    my: '👋 မင်္ဂလာပါ\n\n🎮 Linn Game Store မှ ကြိုဆိုပါတယ်\nGame Top Up နဲ့ Voucher ကို ဒီ Chat ထဲကနေ ဝယ်လို့ရပါတယ်။\n\n👤 စသုံးဖို့ Account လိုပါတယ်၊ လုပ်နည်းကို အောက်မှာ ပို့ထားပါတယ် 👇',
    en: '👋 Welcome\n\n🎮 Linn Game Store\nYou can buy game top-ups and vouchers right here.\n\n👤 You need an account to get started. The steps are right below 👇',
  },
  loginHint: {
    my: '👤 စသုံးဖို့ နည်းလမ်း ၂ ခု ရှိပါတယ်\n\n🅰️ Store ကို မဝင်ချင်ရင် — အောက်က "Bot ထဲမှာ Account ဖွင့်မည်" ကို နှိပ်ရုံပါပဲ (Telegram အချက်အလက်နဲ့ ချက်ချင်း ဖွင့်ပေးပါမယ်)\n🅱️ Store မှာပါ သုံးချင်ရင် — "Open Linn Game Store" → "Log in with Telegram" → ဒီ Chat ပြန်လာပြီး /start ပို့\n\n' + quoteBlock('Password မလိုပါဘူး၊ Telegram နဲ့ပဲ ဖြစ်ပါတယ်။'),
    en: '👤 Two ways to get started\n\n🅰️ Don\'t want to open the store? Just tap "Create account in the bot" below (made instantly from your Telegram details)\n🅱️ Want the store too? "Open Linn Game Store" → "Log in with Telegram" → come back here and send /start\n\n' + quoteBlock('No password needed. It all works with Telegram.'),
  },
  help: {
    my: '💬 အကူအညီ\n\nMenu ခလုတ်တွေက ဒီလိုပါ:\n💼 Wallet — လက်ကျန်ငွေ ကြည့်မယ်၊ ➕ Top Up Wallet နဲ့ ငွေဖြည့်မယ်\n📦 My Orders — Order အခြေအနေ ကြည့်မယ်\n👤 My Account — Account အချက်အလက်\n💬 Help Center — မေးခွန်းတွေ၊ Support\n🌐 Language — ဘာသာစကား ပြောင်းမယ်\n📱 Official Mini App — Game ရွေးဝယ်မယ်\n\n' + quoteBlock('/start — Menu ပြန်ခေါ်မယ်\n/cancel — လုပ်နေတာ ရပ်မယ်') + '\n\nအသစ်ဆိုရင် Help Center → ❓ FAQ ကို အရင်ဖတ်ကြည့်ပါ။',
    en: '💬 Help\n\nWhat the menu buttons do:\n💼 Wallet — check your balance, tap ➕ Top Up Wallet to add money\n📦 My Orders — see your order status\n👤 My Account — your account info\n💬 Help Center — FAQ and Support\n🌐 Language — switch language\n📱 Official Mini App — browse and buy games\n\n' + quoteBlock('/start — show the menu again\n/cancel — stop what you are doing') + '\n\nNew here? Start with Help Center → ❓ FAQ.',
  },
  notConnected: {
    my: '👤 ဒါကို သုံးဖို့ Account လိုပါတယ်\n\n🅰️ "Bot ထဲမှာ Account ဖွင့်မည်" ကို နှိပ်ရင် ချက်ချင်း ရပါပြီ (Store မဝင်ရပါ)\n🅱️ ဒါမှမဟုတ် "Open Linn Game Store" → "Log in with Telegram" → ဒီ Chat ပြန်လာပြီး /start ပို့\n\n' + quoteBlock('မရှင်းရင် 💬 Help Center → ❓ FAQ မှာ ဖတ်လို့ရပါတယ်။'),
    en: '👤 You need an account to use this\n\n🅰️ Tap "Create account in the bot" — instant, no store login\n🅱️ Or "Open Linn Game Store" → "Log in with Telegram" → come back here and send /start\n\n' + quoteBlock('Need more help? See 💬 Help Center → ❓ FAQ.'),
  },
  wallet: {
    my: (balance) => `💼 Wallet\n\nလက်ကျန်ငွေ: ${balance} MMK`,
    en: (balance) => `💼 Wallet\n\nBalance: ${balance} MMK`,
  },
  account: {
    my: (acct) => `👤 My Account\n\nAccount ID: ${acct.guestId}\nနာမည်: ${acct.name || '-'}\nWallet: ${Number(acct.walletBalance || 0).toLocaleString()} MMK`,
    en: (acct) => `👤 My Account\n\nAccount ID: ${acct.guestId}\nName: ${acct.name || '-'}\nWallet: ${Number(acct.walletBalance || 0).toLocaleString()} MMK`,
  },
  ordersEmpty: { my: '📦 Order မှတ်တမ်း မရှိသေးပါ။', en: "📦 You don't have any orders yet." },
  ordersHeader: { my: (page) => `📦 My Orders (စာမျက်နှာ ${page + 1})`, en: (page) => `📦 My Orders (page ${page + 1})` },
  topupPrompt: {
    my: (min, max) => `➕ Wallet ဖြည့်မယ်\n\nပမာဏကို အောက်က ခလုတ်ကနေ ရွေးပါ၊ ဒါမှမဟုတ် ဂဏန်းရိုက်ပို့လည်း ရပါတယ်။\n\n` + quoteBlock(`${min} မှ ${max} MMK အတွင်း\nရပ်ချင်ရင် ❌ ပယ်ဖျက်မည် ကို နှိပ်ပါ`),
    en: (min, max) => `➕ Top Up Wallet\n\nPick an amount below, or just type a number.\n\n` + quoteBlock(`Between ${min} and ${max} MMK\nTo stop, tap ❌ Cancel`),
  },
  helpCenter: {
    my: '💬 Help Center\n\nမေးစရာရှိရင် အောက်ကနေ ရွေးပါ။ အသစ်ဆိုရင် ❓ FAQ ကို အရင်ဖတ်ကြည့်ပါ။\n\n' + quoteBlock('Support ကို ပြောရင် Order ID နဲ့ Screenshot ပါ ပို့ပေးပါ၊ ပိုမြန်ပါတယ်။'),
    en: "💬 Help Center\n\nChoose an option below. New here? Read ❓ FAQ first.\n\n" + quoteBlock("When you contact Support, send your Order ID and a screenshot. It's faster."),
  },
  fallback: {
    my: 'နားမလည်ပါ 🤔 အောက်က Menu ကနေ ရွေးပါ (သို့) /start နှိပ်ပါ။',
    en: "Sorry, I didn't get that 🤔 Please pick an option from the menu below, or send /start.",
  },
  languagePrompt: { my: '🌐 ဘာသာစကား ရွေးပါ / Choose your language', en: '🌐 ဘာသာစကား ရွေးပါ / Choose your language' },
  languageSet: { my: '✅ မြန်မာဘာသာသို့ ပြောင်းလိုက်ပါပြီ။', en: '✅ Language changed to English.' },
  topupExpired: {
    my: 'Top Up ကို မစရသေးပါ (သို့) အချိန်ကုန်သွားပါပြီ။ ➕ Top Up Wallet ကနေ ပြန်စပါ။',
    en: 'This top-up has not started or has expired. Please start again from ➕ Top Up Wallet.',
  },
  topupRateLimited: {
    my: (mins) => `Top Up တောင်းဆိုမှု အများကြီး ပို့ထားပါပြီ။ ${mins} မိနစ်အကြာမှ ထပ်ကြိုးစားပါ၊ (သို့) Help Center ကို ဆက်သွယ်ပါ။`,
    en: (mins) => `You've sent a lot of top-up requests. Please try again in about ${mins} minute${mins === 1 ? '' : 's'}, or contact Help Center.`,
  },
  receiptProcessing: { my: 'Receipt ကို လက်ခံရရှိပါပြီ၊ စစ်ဆေးနေပါတယ်...', en: 'Receipt received, checking it now...' },
  topupSuccess: {
    my: (amount) => `✅ တောင်းဆိုမှု ပို့ပြီးပါပြီ\n\nပမာဏ: ${amount} MMK\n\nAdmin စစ်ပြီးတာနဲ့ Wallet ထဲ ငွေဝင်ပါမယ်၊ Bot ကလည်း အကြောင်းပြန်ပါမယ်။`,
    en: (amount) => `✅ Request sent\n\nAmount: ${amount} MMK\n\nAs soon as our admin checks it, the money goes into your Wallet and the bot will let you know.`,
  },
  receiptFailed: {
    my: 'Receipt တင်လို့ မရသေးပါ။ အောက်က "ထပ်ကြိုးစားမည်" ကို နှိပ်ပါ၊ ဓာတ်ပုံ ပြန်ပို့စရာ မလိုပါ။',
    en: 'We could not upload your receipt. Tap "Try again" below — no need to resend the photo.',
  },

  // ---- Top Up flow ----
  amountInvalid: { my: 'ပမာဏကို ဂဏန်းနဲ့ ရိုက်ထည့်ပါ။ ဥပမာ - 10000', en: 'Please type the amount as a number. Example: 10000' },
  amountMin: { my: (min) => `အနည်းဆုံး ${min} MMK ဖြည့်ရပါမယ်။`, en: (min) => `The minimum top-up is ${min} MMK.` },
  amountMax: { my: (max) => `တစ်ကြိမ်ကို အများဆုံး ${max} MMK ပါ။`, en: (max) => `The maximum per top-up is ${max} MMK.` },
  noMethods: {
    my: 'ငွေပေးချေမှု နည်းလမ်းတွေ အခု မရနိုင်သေးပါ။ Linn Game Store App ထဲက Wallet ကနေ ဖြည့်ကြည့်ပါ။',
    en: 'Payment methods are not available right now. Please try topping up from the Wallet page in the Linn Game Store app.',
  },
  sessionGone: {
    my: 'အချိန်ကုန်သွားပါပြီ။ ➕ Top Up Wallet ကနေ ပြန်စပါ။',
    en: 'This session has expired. Please start again from ➕ Top Up Wallet.',
  },
  methodNotFound: { my: 'ဒီနည်းလမ်း မတွေ့ပါ။ ပြန်ရွေးပါ။', en: 'That payment method was not found. Please pick again.' },
  methodMin: {
    my: (name, min) => `${name} အတွက် အနည်းဆုံး ${min} MMK ပါ။ ပမာဏ ပြောင်းပါ (သို့) တခြားနည်းလမ်း ရွေးပါ။`,
    en: (name, min) => `${name} needs at least ${min} MMK. Change the amount or pick another method.`,
  },
  methodMax: {
    my: (name, max) => `${name} အတွက် အများဆုံး ${max} MMK ပါ။ ပမာဏ ပြောင်းပါ (သို့) တခြားနည်းလမ်း ရွေးပါ။`,
    en: (name, max) => `${name} allows at most ${max} MMK. Change the amount or pick another method.`,
  },
  lastUsedLegend: { my: '⭐ = နောက်ဆုံး သုံးခဲ့တဲ့ နည်းလမ်း', en: '⭐ = last method you used' },
  methodPick: {
    my: (amount, notes) => `ပမာဏ: ${amount} MMK${notes}\n\nဘယ်နည်းနဲ့ ပေးချေမလဲ 👇`,
    en: (amount, notes) => `Amount: ${amount} MMK${notes}\n\nHow would you like to pay? 👇`,
  },
  confirmPrompt: {
    my: (amount, method) => `ပမာဏ: ${amount} MMK\nနည်းလမ်း: ${method}\n\nမှန်ရင် ✅ အတည်ပြုမည် ကို နှိပ်ပါ။`,
    en: (amount, method) => `Amount: ${amount} MMK\nMethod: ${method}\n\nIf that's right, tap ✅ Confirm.`,
  },
  editPrompt: { my: 'ဘာကို ပြင်ချင်ပါသလဲ?', en: 'What would you like to change?' },
  receiptPrompt: {
    my: (method, accName, number, amount) => {
      const hasNum = number && number !== '-';
      return `💳 ${method}\n\nအကောင့်အမည်: ${accName}\nနံပါတ်: ${hasNum ? copyText(number) : '-'}\n` +
        (hasNum ? `👆 နံပါတ်ကို တစ်ချက်နှိပ်ရင် Copy ကူးပြီးသားဖြစ်ပါမယ်။\n` : '') +
        `\n${amount} MMK ကို လွှဲပါ။ လွှဲပြီးရင် Receipt screenshot ကို ဒီ Chat ထဲ ပို့ပါ 📸`;
    },
    en: (method, accName, number, amount) => {
      const hasNum = number && number !== '-';
      return `💳 ${method}\n\nAccount name: ${accName}\nNumber: ${hasNum ? copyText(number) : '-'}\n` +
        (hasNum ? `👆 Tap the number once to copy it.\n` : '') +
        `\nPlease transfer ${amount} MMK, then send your receipt screenshot in this chat 📸`;
    },
  },
  // ---- Security Code (PIN) / Authenticator gate for Top Up ----
  secPinPrompt: {
    my: '🔐 Security Code (PIN ၄ လုံး) ကို ရိုက်ထည့်ပါ။\n\nလုံခြုံရေးအတွက် ရိုက်ပြီးတာနဲ့ ဒီ Message ကို Bot က ဖျက်ပေးပါမယ်။',
    en: '🔐 Please type your Security Code (4-digit PIN).\n\nFor your safety the bot deletes your message right after.',
  },
  secTotpPrompt: {
    my: '🔐 Authenticator App ထဲက ဂဏန်း ၆ လုံး Code ကို ရိုက်ထည့်ပါ။',
    en: '🔐 Please type the 6-digit code from your Authenticator app.',
  },
  secBadPin: { my: 'PIN က ဂဏန်း ၄ လုံး ဖြစ်ရပါမယ်၊ ပြန်ရိုက်ပါ။', en: 'The PIN must be 4 digits. Please try again.' },
  secBadTotp: { my: 'Code က ဂဏန်း ၆ လုံး ဖြစ်ရပါမယ်၊ ပြန်ရိုက်ပါ။', en: 'The code must be 6 digits. Please try again.' },
  secWrong: {
    my: (left) => `❌ မှားနေပါတယ်။ ကျန်တဲ့ အကြိမ် ${left} ကြိမ်။`,
    en: (left) => `❌ Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.`,
  },
  secLocked: {
    my: (mins) => `🔒 အကြိမ်များစွာ မှားသွားလို့ ခဏ ပိတ်ထားပါတယ်။ ${mins} မိနစ်အကြာမှ ပြန်စမ်းပါ။`,
    en: (mins) => `🔒 Too many wrong tries. Locked — try again in about ${mins} min.`,
  },
  secUnavailable: { my: 'ခဏနေမှ ပြန်စမ်းပါ 🙏 (Security စစ်လို့ မရသေးပါ)', en: 'Please try again in a moment 🙏 (could not run the security check).' },
  secRequired: {
    my: 'Security စစ်ဆေးမှု မပြီးသေးပါ။ ➕ Top Up Wallet ကနေ ပြန်စပါ။',
    en: 'Security check not completed. Please start again from ➕ Top Up Wallet.',
  },
  faqHeader: { my: '❓ FAQ — မေးလေ့ရှိသော မေးခွန်းများ\n\nမေးခွန်းတစ်ခု ရွေးပါ 👇', en: '❓ FAQ — common questions\n\nPick a question 👇' },
};

function t(lang, key, ...args) {
  const entry = MESSAGES[key];
  if (!entry) return '';
  const variant = entry[lang] || entry.my;
  return typeof variant === 'function' ? variant(...args) : variant;
}

// Shared by the /language command (added so language switching doesn't
// require memorizing the slash command shape).
async function sendLanguagePicker(env, chatId, telegramId) {
  const cur = await getLanguage(env, telegramId);
  return sendTelegramMessage(env, chatId, t(cur, 'languagePrompt'), {
    inline_keyboard: [[
      { text: (cur === 'my' ? '✅ ' : '') + '🇲🇲 မြန်မာ', callback_data: 'lang:my' },
      { text: (cur === 'en' ? '✅ ' : '') + '🇬🇧 English', callback_data: 'lang:en' },
    ]],
  });
}

// ---------------------------------------------------------------------------
// Security Code (PIN) / Authenticator gate for the in-bot Top Up.
// Same factors the website enforces (worker.js securityGate -> userSecurity/{guestId}), so a
// top-up through the bot is exactly as protected as one made on the site.
// IMPORTANT: PIN hashes are peppered. Set the SAME `SECURITY_PEPPER` secret on BOTH Workers
// (if worker.js has none, it falls back to ITS TELEGRAM_WEBHOOK_SECRET - copy that value here).
// Fails CLOSED: if userSecurity can't be read, the top-up is not allowed to continue.
// ---------------------------------------------------------------------------
const BOT_SEC_MAX_FAILS = 5;
const BOT_SEC_LOCK_STEPS_MS = [15 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000]; // MUST equal SEC_LOCK_STEPS_MS in worker.js (1st / 2nd / 3rd+ lock)
const BOT_SEC_PBKDF2_ITER = 10000; // MUST equal SEC_PBKDF2_ITER in worker.js
const BOT_B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

async function botSecLoad(env, guestId) {
  const token = await getFirestoreAccessToken(env);
  const base = `https://firestore.googleapis.com/v1/projects/${firestoreProjectId(env)}/databases/(default)/documents`;
  const res = await fetch(`${base}/userSecurity/${encodeURIComponent(guestId)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return {};
  if (!res.ok) throw new Error('security read failed ' + res.status);
  const d = await res.json();
  const f = d.fields || {};
  const out = {};
  for (const k of ['pinEnabled', 'pinHash', 'pinSalt', 'totpEnabled', 'totpSecret', 'lastTotpStep', 'fails', 'lockedUntil', 'lockCount']) out[k] = fsField(f, k);
  out._updateTime = d.updateTime || '';   // for the atomic lock reset (never written back)
  return out;
}
const botSecOn = (s) => ({ pin: !!(s.pinEnabled && s.pinHash), totp: !!(s.totpEnabled && s.totpSecret) });

async function botSecPinHash(env, guestId, pin, saltHex) {
  const pepper = String(env.SECURITY_PEPPER || env.TELEGRAM_WEBHOOK_SECRET || '');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pepper + ':' + guestId + ':' + pin), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(String(saltHex).match(/.{2}/g).map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: BOT_SEC_PBKDF2_ITER }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function botB32decode(str) {
  let bits = 0, val = 0; const out = [];
  for (const ch of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    val = (val << 5) | BOT_B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}
async function botTotpCode(secretBytes, step) {
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8);
  let s = step; for (let i = 7; i >= 0; i--) { msg[i] = s & 255; s = Math.floor(s / 256); }
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
async function botTotpVerify(secretB32, code, lastStep) {
  if (!/^\d{6}$/.test(String(code || ''))) return 0;
  const secret = botB32decode(secretB32);
  const now = Math.floor(Date.now() / 30000);
  for (const st of [now, now - 1, now + 1]) {
    if (st <= (Number(lastStep) || 0)) continue;
    if (timingSafeEqualStr(await botTotpCode(secret, st), String(code))) return st;
  }
  return 0;
}

// Firestore atomic commit (needed for the try counter + compare-and-set below).
async function botFsCommit(env, writes) {
  const token = await getFirestoreAccessToken(env);
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${firestoreProjectId(env)}/databases/(default)/documents:commit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ writes }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

// Checks ONE factor ('pin' | 'totp'). Shares fails / lockedUntil / lockCount with the website, so wrong
// tries here and there add up to the same lock. Same rules as worker.js secCheckFactors:
// the try is RESERVED first with an atomic Firestore increment (parallel guessing is impossible),
// then the code is checked. 5 wrong -> lock 15 min, next lock 1 h, then 6 h (a correct code resets it).
// Returns { ok } | { ok:false, locked, left, mins }
async function botSecCheckFactor(env, guestId, s, factor, value) {
  const now = Date.now();
  const mins = (ms) => Math.max(1, Math.ceil(ms / 60000));
  if (Number(s.lockedUntil) > now) return { ok: false, locked: true, mins: mins(Number(s.lockedUntil) - now) };
  const docName = `projects/${firestoreProjectId(env)}/databases/(default)/documents/userSecurity/${guestId}`;
  const path = `userSecurity/${guestId}`;
  // A finished lock opens a fresh window; the updateTime precondition lets only ONE concurrent caller do it.
  if (Number(s.lockedUntil) > 0 || Number(s.fails) >= BOT_SEC_MAX_FAILS) {
    if (!s._updateTime) return { ok: false, locked: true, mins: 1 };
    const r = await botFsCommit(env, [{ update: { name: docName, fields: toFsFields({ fails: 0, lockedUntil: 0 }) }, updateMask: { fieldPaths: ['fails', 'lockedUntil'] }, currentDocument: { updateTime: s._updateTime } }]);
    if (!r.ok) return { ok: false, locked: true, mins: 1 };
  }
  const bump = await botFsCommit(env, [{ update: { name: docName, fields: toFsFields({ lastTryAt: now }) }, updateMask: { fieldPaths: ['lastTryAt'] }, updateTransforms: [{ fieldPath: 'fails', increment: { integerValue: '1' } }] }]);
  const tr = bump.ok && bump.data.writeResults && bump.data.writeResults[0] && bump.data.writeResults[0].transformResults;
  const n = tr && tr[0] && tr[0].integerValue ? parseInt(tr[0].integerValue, 10) : 0;
  if (!n) throw new Error('security counter failed');
  if (n > BOT_SEC_MAX_FAILS) return { ok: false, locked: true, mins: mins(BOT_SEC_LOCK_STEPS_MS[0]) };

  let good = false, step = 0;
  if (factor === 'pin') {
    good = /^\d{4}$/.test(String(value || '')) && timingSafeEqualStr(await botSecPinHash(env, guestId, String(value), s.pinSalt), s.pinHash);
  } else {
    step = await botTotpVerify(s.totpSecret, value, s.lastTotpStep);
    good = step > 0;
  }
  if (!good) {
    if (n >= BOT_SEC_MAX_FAILS) {
      const count = Number(s.lockCount) || 0;
      const dur = BOT_SEC_LOCK_STEPS_MS[Math.min(count, BOT_SEC_LOCK_STEPS_MS.length - 1)];
      await fsMergeDoc(env, path, { lockedUntil: now + dur, lockCount: count + 1 });
      return { ok: false, locked: true, mins: mins(dur) };
    }
    return { ok: false, locked: false, left: BOT_SEC_MAX_FAILS - n };
  }
  const upd = { fails: 0, lockedUntil: 0, lockCount: 0 };
  if (step) upd.lastTotpStep = step;
  await fsMergeDoc(env, path, upd);
  return { ok: true };
}

// 'required' | 'unavailable' | null (= fine to continue). Used at the receipt step too, so a
// session can never skip the PIN prompt by sending the photo early.
async function botTopupSecurityBlocked(env, acct, session) {
  let s;
  try { s = await botSecLoad(env, acct.guestId); } catch (e) { console.error('botSecLoad', e); return 'unavailable'; }
  const on = botSecOn(s);
  if (!on.pin && !on.totp) return null;
  const ok = Number(session.secOkAt) > 0 && Date.now() - Number(session.secOkAt) < SESSION_TIMEOUT_MS;
  return ok ? null : 'required';
}

// After amount + method are confirmed: ask for the PIN / code first (when the customer has them
// switched on), otherwise go straight to the receipt prompt.
async function proceedToReceipt(env, chatId, telegramId, session, secOkAt) {
  await setBotSession(env, telegramId, {
    step: 'awaiting_receipt',
    amount: session.amount,
    paymentMethodName: session.paymentMethodName,
    paymentMethodNumber: session.paymentMethodNumber || '',
    paymentMethodAccountName: session.paymentMethodAccountName || '',
    secOkAt: secOkAt || 0,
  });
  const lang = await getLanguage(env, telegramId);
  return sendRichFlowCard(
    env, chatId,
    receiptBlocks(lang, session.paymentMethodName, session.paymentMethodAccountName || '-', session.paymentMethodNumber || '-', session.amount.toLocaleString()),
    t(lang, 'receiptPrompt', session.paymentMethodName, session.paymentMethodAccountName || '-', session.paymentMethodNumber || '-', session.amount.toLocaleString()),
    cancelInlineKeyboard([
      // Copy button (purple = unstyled): one tap puts the payment number on the clipboard.
      [
        ...(/\d/.test(String(session.paymentMethodNumber || ''))
          ? [{ text: btn(lang, 'copyNumber'), copy_text: { text: String(session.paymentMethodNumber).trim().slice(0, 256) } }]
          : []),
        { text: btn(lang, 'copyAmount'), copy_text: { text: String(Math.round(Number(session.amount) || 0)) } },
      ],
      [
        { text: btn(lang, 'changeAmount'), callback_data: 'topup_back_amount' },
        { text: btn(lang, 'changeMethod'), callback_data: 'topup_back_method' },
      ],
    ], lang)
  );
}

async function startTopupSecurityOrReceipt(env, chatId, telegramId, session, acct, lang) {
  let s;
  try { s = await botSecLoad(env, acct.guestId); }
  catch (e) { console.error('botSecLoad', e); return sendTelegramMessage(env, chatId, t(lang, 'secUnavailable'), MAIN_KEYBOARD); }
  const on = botSecOn(s);
  if (!on.pin && !on.totp) return proceedToReceipt(env, chatId, telegramId, session, 0);
  await setBotSession(env, telegramId, {
    step: on.pin ? 'awaiting_pin' : 'awaiting_totp',
    amount: session.amount,
    paymentMethodName: session.paymentMethodName,
    paymentMethodNumber: session.paymentMethodNumber || '',
    paymentMethodAccountName: session.paymentMethodAccountName || '',
    secOkAt: 0,
  });
  return sendFlowMessage(env, chatId, t(lang, on.pin ? 'secPinPrompt' : 'secTotpPrompt'), cancelInlineKeyboard([], lang));
}

// The customer typed their PIN / authenticator code.
async function handleTopupSecurityInput(env, chatId, telegramId, msg, session, lang) {
  // Never leave a PIN sitting in the chat.
  tgPost(env, 'deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
  const text = String(msg.text || '').trim();
  const factor = session.step === 'awaiting_pin' ? 'pin' : 'totp';

  if (factor === 'pin' && !/^\d{4}$/.test(text)) return sendFlowMessage(env, chatId, t(lang, 'secBadPin'), cancelInlineKeyboard([], lang));
  if (factor === 'totp' && !/^\d{6}$/.test(text)) return sendFlowMessage(env, chatId, t(lang, 'secBadTotp'), cancelInlineKeyboard([], lang));

  // Extra bot-side guard on top of the shared lock counter.
  const rl = await checkRateLimit(env, telegramId, 'topup_sec', { maxCount: 12, windowMs: 10 * 60 * 1000 });
  if (rl.limited) return sendTelegramMessage(env, chatId, t(lang, 'secLocked', Math.max(1, Math.ceil(rl.retryAfterMs / 60000))), MAIN_KEYBOARD);

  const acct = await lookupAccountByTelegramId(env, telegramId);
  if (!acct) { await clearBotSession(env, telegramId); return sendTelegramMessage(env, chatId, t(lang, 'notConnected'), guestMarkup(lang)); }

  let s;
  try { s = await botSecLoad(env, acct.guestId); }
  catch (e) { console.error('botSecLoad', e); return sendTelegramMessage(env, chatId, t(lang, 'secUnavailable'), MAIN_KEYBOARD); }
  const on = botSecOn(s);

  let r;
  try { r = await botSecCheckFactor(env, acct.guestId, s, factor, text); }
  catch (e) { console.error('botSecCheckFactor', e); return sendTelegramMessage(env, chatId, t(lang, 'secUnavailable'), MAIN_KEYBOARD); }
  if (!r.ok) {
    if (r.locked) { await clearBotSession(env, telegramId); return sendTelegramMessage(env, chatId, t(lang, 'secLocked', r.mins), MAIN_KEYBOARD); }
    return sendFlowMessage(env, chatId, t(lang, 'secWrong', r.left), cancelInlineKeyboard([], lang));
  }

  const base = {
    amount: session.amount,
    paymentMethodName: session.paymentMethodName,
    paymentMethodNumber: session.paymentMethodNumber || '',
    paymentMethodAccountName: session.paymentMethodAccountName || '',
  };
  // PIN passed and an authenticator is ALSO on -> ask for the 6-digit code next.
  if (factor === 'pin' && on.totp) {
    await setBotSession(env, telegramId, { step: 'awaiting_totp', ...base, secOkAt: 0 });
    return sendFlowMessage(env, chatId, t(lang, 'secTotpPrompt'), cancelInlineKeyboard([], lang));
  }
  return proceedToReceipt(env, chatId, telegramId, base, Date.now());
}

async function routeTelegramMessage(env, msg) {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from.id);
  const text = (msg.text || '').trim();

  if (text === '/cancel') {
    // Wipe the whole flow (prompts, buttons, typed amount, receipt…) plus the
    // customer's own "/cancel" message, then confirm.
    await cancelFlow(env, chatId, telegramId, [msg.message_id]);
    const lang = await getLanguage(env, telegramId);
    return sendTelegramMessage(env, chatId, t(lang, 'cancelled'), MAIN_KEYBOARD);
  }

  if (isIconCommand(msg.text) && isBotAdmin(env, telegramId)) {
    return handleIconCommand(env, msg);
  }

  // General flood guard — 20 messages/minute per user. Generous enough that
  // no real customer ever notices it; just stops a runaway client/script
  // from hammering Firestore + the Telegram API on every request.
  // Speed: these three Firestore round trips don't depend on each other, so run them side by side
  // instead of one after another (was ~4 sequential calls before the bot could even answer).
  // Each helper already swallows its own errors, so Promise.all can't reject here.
  const [limited, session, lang, acctPre] = await Promise.all([
    isRateLimited(env, telegramId, 'message', { maxCount: 20, windowMs: 60 * 1000 }),
    getBotSession(env, telegramId),
    getLanguage(env, telegramId),
    lookupAccountByTelegramId(env, telegramId),
  ]);
  if (limited) {
    return sendTelegramMessage(env, chatId, t(lang, 'flooded'));
  }

  if (text === '/language') {
    return sendLanguagePicker(env, chatId, telegramId);
  }

  // A wallet top-up flow in progress takes priority over every other
  // command/keyboard button — the person is mid-conversation with the bot
  // (typing an amount, or about to pick a payment method), so route them
  // there first instead of falling through to the menu matching below.
  if (session && session.step === 'awaiting_amount' && text) {
    if (MAIN_MENU_TEXTS.has(normalizeMenuText(text))) {
      await cancelFlow(env, chatId, telegramId);
      // fall through to normal command/menu routing below
    } else {
      await trackFlowMessage(env, chatId, msg.message_id); // customer's typed amount
      return handleTopupAmount(env, chatId, telegramId, text);
    }
  }
  if (session && (session.step === 'awaiting_pin' || session.step === 'awaiting_totp') && text) {
    if (MAIN_MENU_TEXTS.has(normalizeMenuText(text))) {
      await cancelFlow(env, chatId, telegramId);
      // fall through to normal command/menu routing below
    } else {
      return handleTopupSecurityInput(env, chatId, telegramId, msg, session, lang);
    }
  }
  if (session && session.step === 'awaiting_order_id' && text) {
    if (MAIN_MENU_TEXTS.has(normalizeMenuText(text))) {
      await cancelFlow(env, chatId, telegramId);
      // fall through to normal command/menu routing below
    } else {
      return handleTrackOrderId(env, chatId, telegramId, text);
    }
  }
  if (session && session.step === 'awaiting_acc_edit' && text) {
    if (MAIN_MENU_TEXTS.has(normalizeMenuText(text))) {
      await cancelFlow(env, chatId, telegramId);
      // fall through to normal command/menu routing below
    } else {
      await trackFlowMessage(env, chatId, msg.message_id); // customer's typed value
      return handleAccountEditInput(env, msg, session, lang);
    }
  }

  if (session && String(session.step || '').startsWith('buy_') && text) {
    if (MAIN_MENU_TEXTS.has(normalizeMenuText(text))) {
      await cancelFlow(env, chatId, telegramId);
    } else {
      return handleBuyText(env, msg, session, lang);
    }
  }

  const menuKey = normalizeMenuText(text);

  // "🌐 Language" button on the main keyboard — works without login.
  if (menuKey === 'Language') {
    return sendLanguagePicker(env, chatId, telegramId);
  }

  if (text === '/start' || text === '/menu' || menuKey === 'Start') {
    await trackBotUser(env, telegramId, chatId, msg.from);
    // /start also tells the customer their own Telegram ID + username
    // (handy for support / manual account linking). /menu stays unchanged.
    const idInfo = text === '/menu' ? '' : telegramIdInfoBlock(lang, msg.from);
    const acct = acctPre;
    if (acct) {
      const name = acct.name || acct.telegramUsername || msg.from.first_name || 'Player';
      return sendTelegramMessage(env, chatId, t(lang, 'welcomeBack', name) + idInfo, MAIN_KEYBOARD);
    }
    // Guest (not logged in yet): still show the full menu keyboard right away.
    await sendTelegramMessage(env, chatId, t(lang, 'welcomeNew') + idInfo, MAIN_KEYBOARD);
    return sendTelegramMessage(env, chatId, t(lang, 'loginHint'), guestMarkup(lang));
  }

  if (text === '/help') {
    {
      const my = lang !== 'en';
      const blocks = richTableBlocks(my ? '💬 အကူအညီ' : '💬 Help', [
        ['🚀 Start', my ? 'Menu ပြန်ခေါ်မယ်' : 'Show the menu again'],
        ['🎮 Game List', my ? 'Game ရွေးပြီး Bot ထဲကနေ တိုက်ရိုက်ဝယ်' : 'Browse and buy games right here'],
        ['💼 Wallet', my ? 'လက်ကျန်ငွေကြည့်၊ ➕ Top Up Wallet နဲ့ ငွေဖြည့်' : 'Check balance, tap ➕ Top Up Wallet to add money'],
        ['📦 My Orders', my ? 'Order အခြေအနေ ကြည့်' : 'See your order status'],
        ['👤 My Account', my ? 'Account အချက်အလက်' : 'Your account info'],
        ['💬 Help Center', my ? 'မေးခွန်းတွေ၊ Support' : 'FAQ and Support'],
        ['🌐 Language', my ? 'ဘာသာစကား ပြောင်း' : 'Switch language'],
        ['📱 Official Mini App', my ? 'Game ရွေးဝယ်မယ်' : 'Browse and buy games'],
        ['❌ /cancel', my ? 'လုပ်နေတာ ရပ်မယ်' : 'Stop what you are doing'],
      ], my);
      blocks.push(orPara(my ? 'အသစ်ဆိုရင် Help Center → ❓ FAQ ကို အရင်ဖတ်ကြည့်ပါ။' : 'New here? Start with Help Center → ❓ FAQ.'));
      const hid = await sendOrderRich(env, chatId, blocks);
      if (hid) return hid;
    }
    return sendTelegramMessage(env, chatId, t(lang, 'help'), MAIN_KEYBOARD);
  }

  // Game List (in-bot buying) — browsing needs no login; buying checks it.
  if (menuKey === 'Game List' || text === '/games') {
    return sendBuyCategoryMenu(env, chatId, telegramId);
  }

  // Help Center needs no login.
  if (menuKey === 'Help Center') {
    return sendTelegramMessage(env, chatId, t(lang, 'helpCenter'), helpCenterMarkup());
  }

  // Wallet / My Account / My Orders / Top Up Wallet require a logged-in
  // (Telegram-linked) account. Guests get a login prompt; the reply keyboard
  // stays on screen since it is persistent.
  const acct = acctPre;
  if (!acct) {
    if (['Wallet', 'My Account', 'My Orders', 'Top Up Wallet'].includes(menuKey)) {
      return sendTelegramMessage(env, chatId, t(lang, 'notConnected'), guestMarkup(lang));
    }
    return sendTelegramMessage(env, chatId, t(lang, 'fallback'), MAIN_KEYBOARD);
  }

  if (menuKey === 'Wallet') {
    return sendRichCard(
      env, chatId,
      richTableBlocks('💼 Wallet', [[lang === 'en' ? '💰 Balance' : '💰 လက်ကျန်ငွေ', `${Number(acct.walletBalance || 0).toLocaleString()} MMK`]], lang !== 'en'),
      padBubble(t(lang, 'wallet', Number(acct.walletBalance || 0).toLocaleString())),
      TOPUP_INLINE
    );
  }
  if (menuKey === 'My Account') {
    return sendMyAccount(env, chatId, acct, msg.from, lang);
  }
  if (menuKey === 'My Orders') {
    return sendMyOrdersList(env, chatId, acct, lang);
  }
  if (menuKey === 'Top Up Wallet') {
    await Promise.all([
      deleteFlowMessages(env, chatId), // clear any older, abandoned top-up messages
      setBotSession(env, telegramId, { step: 'awaiting_amount' }),
    ]);
    if (!msg.fromMenuButton) await trackFlowMessage(env, chatId, msg.message_id); // a tapped inline menu button is the bot's own message - never queue it for deletion
    return sendFlowMessage(
      env, chatId,
      t(lang, 'topupPrompt', WALLET_TOPUP_MIN.toLocaleString(), WALLET_TOPUP_MAX.toLocaleString()),
      quickAmountKeyboard(0, lang)
    );
  }
  // Fallback — connected but text matched none of the menu buttons/commands
  // above (fat-finger, old keyboard, etc.). Re-show the menu instead of
  // going silent.
  return sendTelegramMessage(env, chatId, t(lang, 'fallback'), MAIN_KEYBOARD);
}

// ---------------------------------------------------------------------------
// In-bot Wallet Top Up flow — amount (text) -> payment method (inline
// button) -> receipt (photo). Mirrors store.html's submitWalletTopup(): same
// "walletTopups" doc shape (amount/paymentMethod/receiptUrl/status/userId/
// userName/userPhone) and the same /ping to the order-approval Worker, so
// the existing admin Confirm/Reject flow picks these up with no admin-side
// changes needed. Step is persisted in Firestore's "telegramBotSessions"
// collection (chat_id-keyed) since a Worker has no in-memory state that
// survives across requests/edge locations.
// ---------------------------------------------------------------------------
async function handleTopupAmount(env, chatId, telegramId, text) {
  const lang = await getLanguage(env, telegramId);
  const amount = Number(String(text).replace(/[^0-9.]/g, ''));
  if (!amount || amount <= 0) {
    return sendFlowMessage(env, chatId, t(lang, 'amountInvalid'), quickAmountKeyboard(0, lang));
  }
  if (amount < WALLET_TOPUP_MIN) {
    return sendFlowMessage(env, chatId, t(lang, 'amountMin', WALLET_TOPUP_MIN.toLocaleString()), quickAmountKeyboard(0, lang));
  }
  if (amount > WALLET_TOPUP_MAX) {
    return sendFlowMessage(env, chatId, t(lang, 'amountMax', WALLET_TOPUP_MAX.toLocaleString()), quickAmountKeyboard(0, lang));
  }
  return proceedToMethodPicker(env, chatId, telegramId, amount);
}

// Shared by handleTopupAmount() (customer typed a number) and the
// 'topup_qty:<amount>' quick-amount-button callback below — both just need
// to land on the payment-method picker once a valid amount is settled on.
async function proceedToMethodPicker(env, chatId, telegramId, amount) {
  const methods = await listPaymentMethods(env);
  if (!methods.length) {
    await clearBotSession(env, telegramId);
    return sendTelegramMessage(env, chatId, t(await getLanguage(env, telegramId), 'noMethods'), openAppInlineKeyboard());
  }

  await setBotSession(env, telegramId, { step: 'awaiting_method', amount });
  return sendPaymentMethodPicker(env, chatId, telegramId, amount);
}

// Sends the "pick a payment method" inline list for a given amount. Shared
// by handleTopupAmount() (first time through) and the 'topup_back_method'
// callback (re-shown when a customer backs out of the receipt step to pick
// a different method) so the star-pinning / cancel-button logic only lives
// in one place.
async function sendPaymentMethodPicker(env, chatId, telegramId, amount) {
  const lang = await getLanguage(env, telegramId);
  const methods = await listPaymentMethods(env);
  if (!methods.length) {
    await clearBotSession(env, telegramId);
    return sendTelegramMessage(env, chatId, t(lang, 'noMethods'), openAppInlineKeyboard());
  }

  const lastMethod = await getLastPaymentMethod(env, telegramId);
  // Pin the last-used method to the top (starred) so a repeat customer
  // doesn't have to re-scan the same list every single top-up.
  const sorted = lastMethod
    ? [...methods].sort((a, b) => (a.id === lastMethod.id ? -1 : b.id === lastMethod.id ? 1 : 0))
    : methods;

  // 2 buttons per row; button text is the method name only (plus ⭐ for the
  // last-used one) so it never truncates. No badges on buttons.
  const methodButtons = sorted.map((m) => ({
    text: lastMethod && m.id === lastMethod.id ? `⭐ ${m.name}` : m.name,
    callback_data: `topup_pm:${m.id}`,
  }));
  const methodRows = [];
  for (let i = 0; i < methodButtons.length; i += 2) methodRows.push(methodButtons.slice(i, i + 2));

  // Short legend under the amount: what ⭐ means + any admin Availability
  // Note (already cleaned of speed wording by cleanAvailabilityNote()).
  const legend = [];
  if (lastMethod) legend.push(t(lang, 'lastUsedLegend'));
  sorted.filter((m) => m.availabilityNote).forEach((m) => legend.push(`${m.name}: ${m.availabilityNote}`));
  const notes = legend.length ? `\n\n${legend.join('\n')}` : '';

  return sendFlowMessage(
    env, chatId,
    t(lang, 'methodPick', amount.toLocaleString(), notes),
    cancelInlineKeyboard(methodRows, lang)
  );
}

// Admin's "Availability Note" text can carry speed wording like "⚡ Available
// fast" — customers no longer see that. Strips the ⚡ emoji and the words
// "available fast" / "fast available" / "fast", tidies leftover punctuation,
// and returns '' when nothing meaningful is left (so no empty note line).
function cleanAvailabilityNote(note) {
  return String(note || '')
    .replace(/\u26a1\ufe0f?/g, '')
    .replace(/\b(?:available\s+fast|fast\s+available|fast)\b/gi, '')
    .replace(/^[\s,.:;|\/\-\u2013\u2014]+|[\s,.:;|\/\-\u2013\u2014]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// "❓ FAQ" — a static, bot-answered FAQ list reachable from Help Center, so
// the most common questions (how to top up, delivery time, refunds, account
// safety) don't need an admin. Tap a question -> its answer, with a "🔙 FAQ
// List" button to go back. Edit FAQ_ITEMS to change the copy; no other code
// needs to change to add/remove a question.
// ---------------------------------------------------------------------------
const FAQ_ITEMS = [
  {
    id: 'start',
    q: '🚀 ဘယ်လိုစသုံးရမလဲ',
    a: [
      '၄ ဆင့်နဲ့ စလို့ရပါတယ် 👇',
      '',
      '1️⃣ Bot ထဲမှာ /start ပို့',
      '2️⃣ "Open Linn Game Store" နဲ့ App ဖွင့်',
      '3️⃣ "Log in with Telegram" နှိပ်',
      '4️⃣ Bot ဆီ ပြန်လာပြီး /start တစ်ခါထပ်ပို့',
      '',
      quoteBlock('Password မလိုပါဘူး။ Login မဝင်သေးရင် Wallet, Orders, Top Up မသုံးနိုင်သေးတာ ပုံမှန်ပါ။'),
    ].join('\n'),
    qEn: '🚀 How do I get started?',
    aEn: [
      'Four steps and you are in 👇',
      '',
      '1️⃣ Send /start to this bot',
      '2️⃣ Tap "Open Linn Game Store" to open the app',
      '3️⃣ Tap "Log in with Telegram"',
      '4️⃣ Come back here and send /start once more',
      '',
      quoteBlock('No password needed. Until you log in, Wallet, Orders and Top Up will not work, and that is normal.'),
    ].join('\n'),
  },
  {
    id: 'buy',
    q: '🎮 Game ဘယ်လိုဝယ်ရမလဲ',
    a: [
      '1️⃣ အောက်က "📱 Official Mini App" ကို နှိပ်',
      '2️⃣ ဆော့တဲ့ Game နဲ့ Package ကို ရွေး',
      '3️⃣ Game ID (လိုရင် Server ID ပါ) ဖြည့်ပြီး Order တင်',
      '',
      '⚠️ ID မှားရင် တခြားသူ Account ကို ရောက်သွားနိုင်လို့ မတင်ခင် ပြန်စစ်ပါ။',
      '',
      quoteBlock('Top Up = Game ထဲ တိုက်ရိုက်ထည့်ပေးတာ၊ Voucher = Code ဝယ်တာပါ။\nငွေကို Wallet ထဲကနေ ဖြတ်ပါတယ်။ မလောက်ရင် "Wallet ထဲ ငွေသွင်းနည်း" ကို ကြည့်ပါ။'),
    ].join('\n'),
  },
  {
    id: 'topup',
    q: '💰 Wallet ထဲ ငွေသွင်းနည်း',
    a: [
      'Wallet ဆိုတာ Game ဝယ်ဖို့ ကြိုထည့်ထားတဲ့ ငွေအိတ်ပါ။',
      '',
      '1️⃣ ➕ Top Up Wallet ကို နှိပ်',
      '2️⃣ ပမာဏ ရွေး (သို့) ရိုက် (ဥပမာ 10000)',
      '3️⃣ ငွေပေးချေမည့် နည်းလမ်း ရွေး',
      '4️⃣ မှန်ရင် ✅ အတည်ပြုမည် ကို နှိပ်',
      '5️⃣ Bot ပြတဲ့ Account ကို ငွေလွှဲ',
      '6️⃣ Receipt screenshot ကို ဒီ Chat ထဲ ပို့',
      '7️⃣ Admin စစ်ပြီးရင် Wallet ထဲ ငွေဝင်ပြီး Bot က ပြောပါမယ်',
      '',
      quoteBlock('အနည်းဆုံး 5,000 / အများဆုံး 10,000,000 MMK\nမှားရင် ✏️ ပြင်မည် ကို နှိပ်ပါ၊ အစကပြန်စစရာ မလိုပါဘူး။'),
      '',
      '⏰ ၁၂ မိနစ်အတွင်း ပြီးအောင်လုပ်ပါ၊ မဟုတ်ရင် အလိုလို ပယ်ဖျက်သွားပါမယ်။ ရပ်ချင်ရင် /cancel ပို့ပါ။',
    ].join('\n'),
    qEn: '💰 How do I add money to my Wallet?',
    aEn: [
      'Your Wallet is money you load in advance to spend on games.',
      '',
      '1️⃣ Tap ➕ Top Up Wallet',
      '2️⃣ Pick an amount, or type one (example: 10000)',
      '3️⃣ Choose a payment method',
      '4️⃣ Check the details and tap ✅ Confirm',
      '5️⃣ Transfer the money to the account shown',
      '6️⃣ Send your receipt screenshot in this chat',
      '7️⃣ Once our admin checks it, the money lands in your Wallet and the bot tells you',
      '',
      quoteBlock('Min 5,000 / Max 10,000,000 MMK\nMade a mistake? Tap ✏️ Edit. No need to start over.'),
      '',
      '⏰ Finish within 12 minutes, or it cancels itself. To stop, send /cancel.',
    ].join('\n'),
  },
  {
    id: 'receipt',
    q: '🧾 Receipt ပို့တာ အဆင်မပြေရင်',
    a: [
      'Receipt ဆိုတာ ငွေလွှဲပြီးကြောင်း ပြတဲ့ Screenshot ပါ။',
      '',
      '✅ ပို့တဲ့အခါ:',
      '• စာမဟုတ်ဘဲ ဓာတ်ပုံအဖြစ် ပို့ပါ',
      '• ပမာဏ၊ အချိန်၊ Transaction ID ရှင်းရှင်းမြင်ရပါမယ်',
      '• ရွေးထားတဲ့ ပမာဏနဲ့ တူရပါမယ်',
      '',
      '📶 တင်လို့မရရင် "ထပ်ကြိုးစားမည်" ခလုတ်ပေါ်လာပါမယ်။ ဓာတ်ပုံ ပြန်ပို့စရာ မလိုပါဘူး။',
      '',
      '❌ ငြင်းပယ်ခံရရင် ပမာဏကွာနေတာ၊ ပုံမရှင်းတာ ဖြစ်နိုင်ပါတယ်။ အကြောင်းသိချင်ရင် 💬 Contact Support ကို Receipt နဲ့အတူ ပြောပါ။',
      '',
      '⚠️ ငွေလွှဲပြီးပေမယ့် Receipt မပို့ရသေးရင် Wallet ထဲ ငွေမဝင်သေးပါဘူး။',
    ].join('\n'),
  },
  {
    id: 'balance',
    q: '💼 လက်ကျန်ငွေ ဘယ်လိုကြည့်မလဲ',
    a: [
      '💼 Wallet ကို နှိပ်ရင် လက်ကျန်ငွေကို ချက်ချင်းပြပါမယ်။ 👤 My Account မှာတော့ Account ID နဲ့ နာမည်ပါ တွေ့ရမယ်။',
      '',
      '🔔 လက်ကျန် 5,000 MMK အောက်ရောက်ရင် Bot က ကြိုသတိပေးပါမယ်။',
    ].join('\n'),
  },
  {
    id: 'delivery',
    q: '⏱️ Order ဘယ်လောက်ကြာလဲ',
    a: [
      'ပုံမှန်ဆို မိနစ် ၅ မှ ၃၀ အတွင်း ပြီးပါတယ်။',
      '',
      'အခြေအနေ ၄ မျိုးရှိပါတယ်:',
      '🕐 Pending — လက်ခံပြီး စောင့်နေတယ်',
      '⏳ Processing — Admin လုပ်နေတယ်',
      '✅ Success — ပြီးပါပြီ၊ Game ထဲ စစ်ကြည့်လို့ရပြီ',
      '❌ Fail — ပြဿနာရှိတယ် ("Order မအောင်မြင်ရင်" ကို ကြည့်ပါ)',
      '',
      'အခြေအနေ ပြောင်းတိုင်း Bot က ပြောပါမယ်။',
      '',
      quoteBlock('မိနစ် ၃၀ ကျော်နေရင် Order ID နဲ့ 💬 Contact Support ကို ပြောပါ။ Order ကိုတော့ ထပ်မတင်ပါနဲ့၊ ငွေနှစ်ခါ ကျနိုင်ပါတယ်။'),
    ].join('\n'),
  },
  {
    id: 'track',
    q: '🔍 Order ကို ဘယ်လိုစစ်မလဲ',
    a: [
      'နည်းလမ်း ၂ ခုရှိပါတယ်:',
      '',
      '📦 My Orders — မကြာသေးခင် Order ၅ ခုကို ပြပါမယ်။ တစ်ခုချင်းအောက်က "အသေးစိတ်" ကို နှိပ်ရင် အချိန်၊ ငွေပေးချေခဲ့တဲ့ နည်းလမ်း၊ အခြေအနေ အပြည့်အစုံ တွေ့ရမယ်။',
      '',
      '🔍 Track my order — Order အဟောင်းတွေ My Orders ထဲမှာ မပေါ်တော့ရင် 💬 Help Center → 🔍 Track my order ကနေ Order ID ရိုက်ပြီး ရှာပါ။',
      '',
      '📌 Order ID က Order တင်ချိန် Message ထဲမှာ ပါပါတယ်။ Copy ကူးသုံးရင် မှားစရာမရှိပါဘူး။',
    ].join('\n'),
  },
  {
    id: 'refund',
    q: '↩️ Order မအောင်မြင်ရင်',
    a: [
      'Order မအောင်မြင်ရင် (❌ Fail) စိတ်မပူပါနဲ့၊ ဖြတ်ထားတဲ့ ငွေကို Wallet ထဲ ပြန်ထည့်ပေးပါတယ်။',
      '',
      'ဖြစ်တတ်တဲ့ အကြောင်းရင်း:',
      '• Game ID (သို့) Server ID မှားနေတာ',
      '• Game ဘက်မှာ ယာယီပြဿနာရှိတာ',
      '• Package ယာယီ ပြတ်နေတာ',
      '',
      'လုပ်ရမှာ:',
      '1️⃣ Bot ပို့တဲ့ Message ထဲက မှတ်ချက်ကို ဖတ်ပါ',
      '2️⃣ 💼 Wallet မှာ ငွေပြန်ဝင်လား ကြည့်ပါ',
      '3️⃣ မဝင်ရင် (သို့) မရှင်းရင် Order ID နဲ့ 💬 Contact Support ကို ပြောပါ',
      '',
      '💡 ID ကို ပြန်စစ်ပြီးမှ Order အသစ်တင်ပါ။',
    ].join('\n'),
  },
  {
    id: 'account',
    q: '🔒 Account လုံခြုံရေး',
    a: [
      'Account က Telegram နဲ့ ချိတ်ထားတာမို့ Password မေ့စရာ မလိုသလို ဘယ်သူ့ကိုမှလည်း မပေးရပါဘူး။',
      '',
      '🔗 Telegram တစ်ခုကို Account တစ်ခုနဲ့ ချိတ်ပြီးရင် တခြားသူ ပြန်ချိတ်လို့ မရတော့ပါဘူး။',
      '',
      '🔄 ငွေရှိပြီးသား Account ကို Telegram အသစ်နဲ့ ပြောင်းချင်ရင် လုံခြုံရေးအတွက် Admin ကို ဆက်သွယ်ပြီး Verify လုပ်ရပါမယ်။',
      '',
      '⚠️ Admin လို့ပြောပြီး Password / OTP / Login Code မေးရင် ဘယ်တော့မှ မပေးပါနဲ့။ ငွေလွှဲခိုင်းရင်လည်း Account အမည်ကို သေချာစစ်ပါ။ တရားဝင် Support က @linn270_0 ပါ။',
    ].join('\n'),
  },
  {
    id: 'language',
    q: '🌐 ဘာသာစကား ပြောင်းနည်း',
    a: [
      'Menu ထဲက "🌐 Language" ကို နှိပ်ပြီး မြန်မာ (သို့) English ကို ရွေးပါ။ /language ပို့လည်း ရပါတယ်။',
      '',
      'ပြောင်းပြီးရင် Menu၊ Help Center နဲ့ Top Up စာတွေ ရွေးထားတဲ့ ဘာသာနဲ့ ပြပါမယ်။',
    ].join('\n'),
    qEn: '🌐 How do I change the language?',
    aEn: [
      'Tap "🌐 Language" in the menu and choose မြန်မာ or English. Sending /language works too.',
      '',
      'After you switch, the menu, Help Center and Top Up messages follow your choice.',
    ].join('\n'),
  },
  {
    id: 'stuck',
    q: '🆘 Bot မတုံ့ပြန်ရင် / မရှင်းရင်',
    a: [
      'အောက်ကဟာတွေ အရင်စမ်းကြည့်ပါ:',
      '',
      '1️⃣ /start ပြန်ပို့ပါ၊ Menu အသစ်ပြန်ပေါ်လာပါမယ်',
      '2️⃣ "Login အရင်ဝင်ပါ" လို့ပြရင် App ထဲက "Log in with Telegram" နဲ့ ဝင်ပြီး /start ပြန်ပို့ပါ',
      '3️⃣ ငွေသွင်းနေရင်း ရပ်သွားရင် /cancel ပို့ပြီး ➕ Top Up Wallet ကနေ ပြန်စပါ',
      '4️⃣ "Top Up တောင်းဆိုမှု အများကြီး" လို့ပြရင် ပြတဲ့ မိနစ်အတိုင်း စောင့်ပါ',
      '',
      'မရသေးရင် Screenshot နဲ့အတူ 💬 Contact Support ကို ပြောပါ။',
    ].join('\n'),
  },
];

function faqListMarkup(lang = 'my') {
  return {
    inline_keyboard: [
      ...FAQ_ITEMS.map((it) => [{ text: (lang === 'en' && it.qEn) || it.q, callback_data: `faq:${it.id}` }]),
      // Extra shortcut so a customer sitting at the bottom of the FAQ list
      // can jump straight back to Help Center instead of backing out via
      // an answer's "🔙 FAQ List" button first.
      [styled({ text: '💬 Help Center', callback_data: 'faq:help_center' }, 'primary')],
    ],
  };
}

async function handleFaqCallback(env, cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const messageId = cq.message && cq.message.message_id;
  const telegramId = String(cq.from.id);
  if (!chatId || !messageId) return answerCallbackQuery(env, cq.id);
  await answerCallbackQuery(env, cq.id);

  const id = (cq.data || '').split(':')[1];
  const lang = await getLanguage(env, telegramId);

  if (id === 'help_center') {
    return editTelegramMessage(env, chatId, messageId, t(lang, 'helpCenter'), helpCenterMarkup());
  }

  const item = FAQ_ITEMS.find((it) => it.id === id);
  if (!item) {
    return editTelegramMessage(env, chatId, messageId, t(lang, 'faqHeader'), faqListMarkup(lang));
  }
  const q = (lang === 'en' && item.qEn) || item.q;
  const a = (lang === 'en' && item.aEn) || item.a;
  return editTelegramMessage(env, chatId, messageId, `${q}\n\n${a}`, {
    inline_keyboard: [[{ text: btn(lang, 'faqList'), callback_data: 'faq:list' }]],
  });
}

// ---------------------------------------------------------------------------
// "🔍 Track my order" — reachable from Help Center. Unlike 📦 My Orders
// (which only lists the 5 most recent), this looks up ANY order by its
// exact ID, so an older order still shows. Uses the same telegramBotSessions
// step machinery as the wallet top-up flow ("awaiting_order_id"), so typing
// an order ID after tapping the button is picked up in routeTelegramMessage
// above, one-shot (no multi-step wizard needed here).
// ---------------------------------------------------------------------------
async function handleTrackOrderCallback(env, cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const telegramId = String(cq.from.id);
  if (!chatId) return answerCallbackQuery(env, cq.id);
  await answerCallbackQuery(env, cq.id);
  await setBotSession(env, telegramId, { step: 'awaiting_order_id' });
  return sendFlowMessage(
    env, chatId,
    '🔍 Order ID ရိုက်ထည့်ပါ\n\n' + quoteBlock('ဥပမာ: 12345 (သို့) #12345\nရပ်ချင်ရင် ❌ ပယ်ဖျက်မည် ကို နှိပ်ပါ'),
    cancelInlineKeyboard([], await getLanguage(env, telegramId))
  );
}

async function handleTrackOrderId(env, chatId, telegramId, text) {
  await clearBotSession(env, telegramId);
  const acct = await lookupAccountByTelegramId(env, telegramId);
  if (!acct) {
    return sendTelegramMessage(env, chatId, 'Account မချိတ်ဆက်ရသေးပါ။ App ထဲက Telegram Login ကို အရင်သုံးပြီး /start ကို ပြန်နှိပ်ပါ။', MAIN_KEYBOARD);
  }
  const orderId = text.trim().replace(/^#/, '');
  const order = await lookupOrderById(env, orderId);
  if (!order || order.userId !== acct.guestId) {
    return sendTelegramMessage(env, chatId, `❌ Order #${orderId} မတွေ့ပါ\n\n` + quoteBlock('ID ကို ပြန်စစ်ပါ။ Order တင်ချိန်က Message ထဲက ID ကို Copy ကူးရင် မှားစရာမရှိပါဘူး။'), MAIN_KEYBOARD);
  }
  { const id = await sendOrderRich(env, chatId, buildOrderDetailBlocks(order)); if (id) return id; }
  return sendTelegramMessage(env, chatId, buildOrderDetailText(order), MAIN_KEYBOARD);
}

// ---------------------------------------------------------------------------
// 📦 My Orders — now sends the recent-orders summary with one "🧾 #ID
// အသေးစိတ်" inline button per order (instead of plain text only), so
// tapping an order shows its full detail (game, price, timeline, date, and
// payment method/receipt/note when the "orders" doc happens to carry them)
// without leaving the chat. Shared by the "📦 My Orders" button and the
// "🔙 Back" button inside an order's detail view.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 👤 My Account — full profile card: Account ID, store nickname, Telegram
// name + @username, Chat ID, wallet, order counts, join date, language. Two
// copy buttons only (Account ID, Chat ID) — the two things a customer
// actually pastes into support chats. Telegram ID and Chat ID are the same
// number in a private bot chat, so they are shown as one line.
// ---------------------------------------------------------------------------
async function countOrders(env, guestId, successOnly) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runAggregationQuery`;
    const userFilter = { fieldFilter: { field: { fieldPath: 'userId' }, op: 'EQUAL', value: { stringValue: guestId } } };
    const where = successOnly
      ? { compositeFilter: { op: 'AND', filters: [userFilter, { fieldFilter: {
          field: { fieldPath: 'status' }, op: 'IN',
          value: { arrayValue: { values: ['Success', 'success', 'Completed', 'completed', 'Delivered', 'delivered'].map((v) => ({ stringValue: v })) } },
        } }] } }
      : userFilter;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ structuredAggregationQuery: { aggregations: [{ alias: 'n', count: {} }], structuredQuery: { from: [{ collectionId: 'orders' }], where } } }),
    });
    if (!res.ok) return null;
    const rows = await res.json();
    const v = rows && rows[0] && rows[0].result && rows[0].result.aggregateFields && rows[0].result.aggregateFields.n;
    return v ? Number(v.integerValue || 0) : null;
  } catch (e) {
    console.error('countOrders failed:', e);
    return null;
  }
}

async function sendMyAccount(env, chatId, acct, from, lang) {
  const [total, success] = await Promise.all([countOrders(env, acct.guestId, false), countOrders(env, acct.guestId, true)]);
  const my = lang !== 'en';
  const tgName = [from && from.first_name, from && from.last_name].filter(Boolean).join(' ');
  const username = (from && from.username) || acct.telegramUsername;
  const joined = acct.createdAt instanceof Date && !isNaN(acct.createdAt.getTime())
    ? acct.createdAt.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : '';
  const lines = [
    '👤 My Account',
    '',
    `Account ID: ${acct.guestId}`,
    `${my ? 'နာမည်' : 'Nickname'}: ${acct.name || '-'}`,
    `${my ? 'ဖုန်း' : 'Phone'}: ${acct.phone || '-'}`,
    `Email: ${acct.email || '-'}`,
    tgName ? `Telegram ${my ? 'နာမည်' : 'Name'}: ${tgName}` : null,
    `Username: ${username ? '@' + String(username).replace(/^@/, '') : (my ? 'မရှိပါ' : 'Not set')}`,
    `Chat ID: ${chatId}`,
    '',
    `Wallet: ${Number(acct.walletBalance || 0).toLocaleString()} MMK`,
    total === null ? null : `Orders: ${total.toLocaleString()}${success === null ? '' : ` (Success ${success.toLocaleString()})`}`,
    joined ? `${my ? 'ဝင်ရောက်ခဲ့သည့်ရက်' : 'Joined'}: ${joined}` : null,
    `${my ? 'ဘာသာစကား' : 'Language'}: ${my ? 'မြန်မာ' : 'English'}`,
  ].filter((l) => l !== null);
  const markup = {
    inline_keyboard: [[
      { text: '📋 Account ID', copy_text: { text: String(acct.guestId) } },
      { text: '📋 Chat ID', copy_text: { text: String(chatId) } },
    ], [
      styled({ text: my ? '✏️ အချက်အလက် ပြင်မည်' : '✏️ Edit info', callback_data: 'acc:edit' }, 'primary'),
    ]],
  };
  const rows = [
    ['🆔 Account ID', String(acct.guestId)],
    [`👤 ${my ? 'နာမည်' : 'Nickname'}`, acct.name || '-'],
    [`📱 ${my ? 'ဖုန်း' : 'Phone'}`, acct.phone || '-'],
    ['✉️ Email', acct.email || '-'],
  ];
  if (tgName) rows.push([`✈️ Telegram ${my ? 'နာမည်' : 'Name'}`, tgName]);
  rows.push(['🔖 Username', username ? '@' + String(username).replace(/^@/, '') : (my ? 'မရှိပါ' : 'Not set')]);
  rows.push(['💬 Chat ID', String(chatId)]);
  rows.push(['💰 Wallet', `${Number(acct.walletBalance || 0).toLocaleString()} MMK`]);
  if (total !== null) rows.push(['📦 Orders', `${total.toLocaleString()}${success === null ? '' : ` (Success ${success.toLocaleString()})`}`]);
  if (joined) rows.push([`🕐 ${my ? 'ဝင်ရောက်ခဲ့သည့်ရက်' : 'Joined'}`, joined]);
  rows.push([`🌐 ${my ? 'ဘာသာစကား' : 'Language'}`, my ? 'မြန်မာ' : 'English']);
  return sendRichCard(env, chatId, richTableBlocks('👤 My Account', rows, my), padBubble(lines.join('\n')), markup);
}

// ---------------------------------------------------------------------------
// "Edit info" on My Account — the customer can set/change nickname, phone and
// email. Saved on users/{guestId}, the same doc the website reads, so the data
// comes back after a Telegram sign-in from any browser or device (the sign-in
// resolves telegramAccounts/tg_<id> -> the same guestId). Uses the same
// telegramBotSessions step machinery as "Track my order": step
// "awaiting_acc_edit" + accField, picked up in routeTelegramMessage.
// ---------------------------------------------------------------------------
const ACC_FIELDS = ['name', 'phone', 'email'];
const ACC_DB_KEY = { name: 'name', phone: 'phone', email: 'contactEmail' };   // Firestore key per field

function accFieldLabel(lang, field) {
  if (field === 'name') return bt(lang, 'နာမည်', 'Nickname');
  if (field === 'phone') return bt(lang, 'ဖုန်းနံပါတ်', 'Phone number');
  return 'Email';
}

// Returns the cleaned value, or null when it is not acceptable.
function normalizeAccValue(field, raw) {
  const s = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (field === 'name') {
    const v = s.replace(/\s+/g, ' ');
    return v.length >= 1 && v.length <= 100 ? v : null;
  }
  if (field === 'phone') {
    const v = s.replace(/[\s\-().]/g, '');
    return /^\+?[0-9]{7,15}$/.test(v) ? v : null;
  }
  const v = s.toLowerCase();
  return v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? v : null;
}

function accFieldHint(lang, field) {
  if (field === 'name') return bt(lang, 'နာမည် (အများဆုံး ၁၀၀ လုံး) ကို ရိုက်ပို့ပါ', 'Type your nickname (up to 100 characters)');
  if (field === 'phone') return bt(lang, 'ဖုန်းနံပါတ် ရိုက်ပို့ပါ\nဥပမာ: 09123456789 (သို့) +959123456789', 'Type your phone number\nExample: 09123456789 or +959123456789');
  return bt(lang, 'Email ရိုက်ပို့ပါ\nဥပမာ: name@example.com', 'Type your email\nExample: name@example.com');
}

async function accEditDone(env, chatId, telegramId, from, lang, note) {
  const fresh = await lookupAccountByTelegramId(env, telegramId);
  await sendTelegramMessage(env, chatId, note, MAIN_KEYBOARD);
  if (fresh) await sendMyAccount(env, chatId, fresh, from, lang);
}

// Callbacks: acc:edit (pick a field) | acc:f:<field> (prompt for it) | acc:c:<field> (clear phone/email)
async function handleAccountEditCallback(env, cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const telegramId = String(cq.from.id);
  if (!chatId) return answerCallbackQuery(env, cq.id);
  const parts = String(cq.data || '').split(':');

  if (parts[1] === 'edit') {
    // the picker needs no account data, so no lookup here; language + clearing an older flow run side by side
    await answerCallbackQuery(env, cq.id);
    const [lang] = await Promise.all([
      getLanguage(env, telegramId),
      cancelFlow(env, chatId, telegramId),   // drop any older half-finished flow
    ]);
    return sendFlowMessage(env, chatId, `✏️ ${bt(lang, 'ဘာကို ပြင်မလဲ?', 'What do you want to change?')}`, {
      inline_keyboard: [
        [{ text: `👤 ${accFieldLabel(lang, 'name')}`, callback_data: 'acc:f:name' }, { text: `📱 ${accFieldLabel(lang, 'phone')}`, callback_data: 'acc:f:phone' }],
        [{ text: '✉️ Email', callback_data: 'acc:f:email' }],
        [styled({ text: btn(lang, 'cancel'), callback_data: 'topup_cancel' }, 'danger')],
      ],
    });
  }

  const field = parts[2];
  if (!ACC_FIELDS.includes(field)) return answerCallbackQuery(env, cq.id);
  const [lang, acct] = await Promise.all([getLanguage(env, telegramId), lookupAccountByTelegramId(env, telegramId)]);
  if (!acct) {
    await answerCallbackQuery(env, cq.id);
    return sendTelegramMessage(env, chatId, t(lang, 'notConnected'), guestMarkup(lang));
  }

  if (parts[1] === 'f') {
    await answerCallbackQuery(env, cq.id);
    await setBotSession(env, telegramId, { step: 'awaiting_acc_edit', accField: field });
    const extra = field !== 'name' && acct[field]
      ? [[{ text: bt(lang, '🗑 ဖျက်မည်', '🗑 Remove'), callback_data: `acc:c:${field}` }]]
      : [];
    const current = acct[field] ? `${bt(lang, 'လက်ရှိ', 'Current')}: ${acct[field]}\n\n` : '';
    return sendFlowMessage(env, chatId, `✏️ ${accFieldLabel(lang, field)}\n\n${current}${quoteBlock(accFieldHint(lang, field))}`, cancelInlineKeyboard(extra, lang));
  }

  if (parts[1] === 'c' && field !== 'name') {
    await answerCallbackQuery(env, cq.id);
    try {
      await fsMergeDoc(env, `users/${acct.guestId}`, { [ACC_DB_KEY[field]]: '' });
    } catch (e) {
      console.error('account field clear failed:', e);
      return sendFlowMessage(env, chatId, bt(lang, 'ဖျက်လို့ မရပါ။ ပြန်ကြိုးစားပါ။', 'Could not remove it. Please try again.'), cancelInlineKeyboard([], lang));
    }
    await cancelFlow(env, chatId, telegramId, [cq.message && cq.message.message_id]);
    return accEditDone(env, chatId, telegramId, cq.from, lang, `✅ ${accFieldLabel(lang, field)} ${bt(lang, 'ကို ဖျက်ပြီးပါပြီ', 'removed')}`);
  }
  return answerCallbackQuery(env, cq.id);
}

async function handleAccountEditInput(env, msg, session, lang) {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from.id);
  const field = session.accField;
  if (!ACC_FIELDS.includes(field)) {
    await cancelFlow(env, chatId, telegramId, [msg.message_id]);
    return;
  }
  const value = normalizeAccValue(field, msg.text);
  if (value === null) {
    return sendFlowMessage(env, chatId, `⚠️ ${bt(lang, 'ပုံစံ မမှန်ပါ။ ပြန်ရိုက်ပါ။', 'That does not look right. Please try again.')}\n\n${quoteBlock(accFieldHint(lang, field))}`, cancelInlineKeyboard([], lang));
  }
  const acct = await lookupAccountByTelegramId(env, telegramId);
  if (!acct) {
    await cancelFlow(env, chatId, telegramId, [msg.message_id]);
    return sendTelegramMessage(env, chatId, t(lang, 'notConnected'), guestMarkup(lang));
  }
  try {
    await fsMergeDoc(env, `users/${acct.guestId}`, { [ACC_DB_KEY[field]]: value });
  } catch (e) {
    console.error('account field save failed:', e);
    return sendFlowMessage(env, chatId, bt(lang, 'သိမ်းလို့ မရပါ။ ပြန်ကြိုးစားပါ။', 'Could not save. Please try again.'), cancelInlineKeyboard([], lang));
  }
  // wipe the prompts and the typed value (phone/email stay out of the chat), then show the fresh card
  await cancelFlow(env, chatId, telegramId, [msg.message_id]);
  return accEditDone(env, chatId, telegramId, msg.from, lang, `✅ ${accFieldLabel(lang, field)} ${bt(lang, 'ကို သိမ်းပြီးပါပြီ', 'saved')}`);
}

// ---- Bordered-table cards (rich message) with classic text as the fallback ----
function richTableBlocks(title, rows, my = true) {
  return [
    orPara(title, true),
    {
      type: 'table', is_bordered: true, is_compact: true,
      cells: [
        [orCell(my ? 'အချက်အလက်' : 'Info', true), orCell(my ? 'အသေးစိတ်' : 'Details', true)],
        ...rows.map((r) => [orCell(r[0]), orCell(r[1])]),
      ],
    },
  ];
}
function richButtonBlocks(markup) {
  const clean = cleanButtonLabels(markup);
  const out = [];
  for (const row of evenRows((clean && clean.inline_keyboard) || [])) {
    if (!Array.isArray(row) || !row.length) continue;
    out.push({ type: 'buttons', align: 'center', buttons: row.slice(0, 8).map((b) => { const { icon_custom_emoji_id, ...rest } = b || {}; return rest; }) });
  }
  return out;
}
async function sendRichCard(env, chatId, blocks, fallbackText, markup) {
  const id = await sendOrderRich(env, chatId, blocks.concat(richButtonBlocks(markup)));
  if (id) return id;
  return sendTelegramMessage(env, chatId, fallbackText, markup);
}
async function editRichCard(env, chatId, messageId, blocks, fallbackText, markup) {
  if (await editOrderRich(env, chatId, messageId, blocks.concat(richButtonBlocks(markup)))) return true;
  return editTelegramMessage(env, chatId, messageId, fallbackText, markup);
}

function buildOrderDetailBlocks(order) {
  const dateLine = formatOrderDate(order.timestamp);
  // compact: game + package together, player + server together, no payment-method row
  const pkg = order.itemAmount ? `${order.itemAmount}${Number(order.quantity) > 1 ? ` × ${Number(order.quantity)}` : ''}` : '';
  const rows = [['🧾 Order', `#${order.id}`], ['🎮 Game', [order.game || '-', pkg].filter(Boolean).join(' · ')]];
  if (order.playerId) rows.push(['🆔 ID', order.serverId ? `${order.playerId} (${order.serverId})` : String(order.playerId)]);
  if (order.charName) rows.push(['🧑 နာမည်', String(order.charName)]);
  rows.push(['💰 ဈေး', `${Number(order.price || 0).toLocaleString()} MMK`]);
  if (dateLine) rows.push(['🕐 ရက်', dateLine]);
  rows.push(['📌 Status', orderStatusBadge(order.status)]);
  const blocks = richTableBlocks(`🧾 Order #${order.id}`, rows);
  const tl = orderTimelineLine(order.status);
  if (tl) blocks.push(orPara(tl));
  if (order.note) blocks.push(orPara('📝 Admin မှတ်ချက်', true), orPara(order.note));
  if (order.receiptUrl) blocks.push(orPara(`🧾 Receipt: ${order.receiptUrl}`));
  return blocks;
}

const ORDERS_PAGE_SIZE = 4;

// One page of the order list: 4 orders, 2 short lines each, then one
// colour-coded button per order (green = Success, red = Fail, blue =
// Pending/Processing) and a Back / Next row. `orders` may hold one extra row
// (page size + 1) — that extra row only tells us a Next page exists.
function buildOrdersListMessage(orders, lang, page = 0) {
  const hasNext = orders.length > ORDERS_PAGE_SIZE;
  const shown = orders.slice(0, ORDERS_PAGE_SIZE);
  const blocks = shown.map((o) => {
    const d = o.timestamp instanceof Date && !isNaN(o.timestamp.getTime())
      ? o.timestamp.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      : '';
    return [
      `#${o.id} — ${o.game || '-'}`,
      `${Number(o.price || 0).toLocaleString()} MMK${d ? ` · ${d}` : ''} · ${orderStatusBadge(o.status)}`,
    ].join('\n');
  });
  const rows = shown.map((o) => [
    styled({ text: `#${o.id} · ${orderStatusWord(o.status)}`, callback_data: `ord:${o.id}:${page}` }, orderButtonStyle(o.status)),
  ]);
  const nav = [];
  if (page > 0) nav.push(styled({ text: btn(lang, 'prev'), callback_data: `ord:pg:${page - 1}` }, 'primary'));
  if (hasNext) nav.push(styled({ text: btn(lang, 'next'), callback_data: `ord:pg:${page + 1}` }, 'primary'));
  if (nav.length) rows.push(nav);
  const my = lang !== 'en';
  const tableRows = shown.map((o) => {
    const d = o.timestamp instanceof Date && !isNaN(o.timestamp.getTime())
      ? o.timestamp.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      : '';
    return [`#${o.id}`, o.game || '-', `${Number(o.price || 0).toLocaleString()} MMK${d ? `\n${d}` : ''}`, orderStatusBadge(o.status)];
  });
  const richBlocks = [
    orPara(t(lang, 'ordersHeader', page), true),
    {
      type: 'table', is_bordered: true, is_compact: true,
      cells: [
        ['Order ID', 'Game', my ? 'ငွေ' : 'Amount', 'Status'].map((h) => orCell(h, true)),
        ...tableRows.map((r) => r.map((c) => orCell(c))),
      ],
    },
  ];
  return {
    text: padBubble(`${t(lang, 'ordersHeader', page)}\n\n${blocks.join('\n\n')}`),
    replyMarkup: { inline_keyboard: rows },
    richBlocks,
  };
}

async function loadOrdersPage(env, guestId, page) {
  return lookupRecentOrders(env, guestId, page * ORDERS_PAGE_SIZE, ORDERS_PAGE_SIZE + 1);
}

async function sendMyOrdersList(env, chatId, acct, lang) {
  const orders = await loadOrdersPage(env, acct.guestId, 0);
  if (!orders.length) return sendTelegramMessage(env, chatId, t(lang, 'ordersEmpty'), MAIN_KEYBOARD);
  const { text, replyMarkup, richBlocks } = buildOrdersListMessage(orders, lang, 0);
  return sendRichCard(env, chatId, richBlocks, text, replyMarkup);
}

function buildOrderDetailText(order) {
  const dateLine = formatOrderDate(order.timestamp);
  const timeline = orderTimelineLine(order.status);
  const lines = [
    `🧾 Order #${order.id}`,
    `🎮 ${order.game || '-'}`,
    order.itemAmount ? `📦 ${order.itemAmount}${Number(order.quantity) > 1 ? ` × ${Number(order.quantity)}` : ''}` : null,
    order.playerId ? `🆔 ${order.playerId}${order.serverId ? ` (${order.serverId})` : ''}` : null,
    order.charName ? `🧑 ${order.charName}` : null,
    `💰 ${Number(order.price || 0).toLocaleString()} MMK`,
    dateLine ? `🕐 ${dateLine}` : null,
    timeline ? `\n${timeline}` : null,
    order.paymentMethod ? `\n💳 ငွေပေးချေမှု: ${order.paymentMethod}` : null,
    order.note ? `\n📝 ${order.note}` : null,
    order.receiptUrl ? `\n🧾 Receipt: ${order.receiptUrl}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

async function handleOrderDetailCallback(env, cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const messageId = cq.message && cq.message.message_id;
  const telegramId = String(cq.from.id);
  // Callback shapes: ord:<orderId>:<page> | ord:pg:<page> | ord:back[:<page>]
  const parts = (cq.data || '').split(':');
  const orderId = parts[1];
  if (!chatId || !messageId || !orderId) return answerCallbackQuery(env, cq.id);

  const lang = await getLanguage(env, telegramId);
  const acct = await lookupAccountByTelegramId(env, telegramId);
  if (!acct) {
    await answerCallbackQuery(env, cq.id);
    return editTelegramMessage(env, chatId, messageId, t(lang, 'notConnected'), null);
  }

  // List page (Next / Back buttons, and "Back" from an order's detail view).
  if (orderId === 'back' || orderId === 'pg') {
    await answerCallbackQuery(env, cq.id);
    const page = Math.max(0, parseInt(parts[2], 10) || 0);
    const orders = await loadOrdersPage(env, acct.guestId, page);
    if (!orders.length) {
      if (page > 0) return; // stale Next button past the last page — leave the message as is
      return editTelegramMessage(env, chatId, messageId, t(lang, 'ordersEmpty'), null);
    }
    const { text, replyMarkup, richBlocks } = buildOrdersListMessage(orders, lang, page);
    return editRichCard(env, chatId, messageId, richBlocks, text, replyMarkup);
  }

  const page = Math.max(0, parseInt(parts[2], 10) || 0);
  const order = await lookupOrderById(env, orderId);
  if (!order || order.userId !== acct.guestId) {
    return answerCallbackQuery(env, cq.id, 'ဤ Order ကို မတွေ့ရှိပါ။');
  }
  await answerCallbackQuery(env, cq.id);
  return editRichCard(env, chatId, messageId, buildOrderDetailBlocks(order), padBubble(buildOrderDetailText(order)), {
    inline_keyboard: [[
      { text: btn(lang, 'copyOrderId'), copy_text: { text: String(order.id) } },
      styled({ text: btn(lang, 'prev'), callback_data: `ord:back:${page}` }, 'primary'),
    ]],
  });
}

async function routeTelegramCallback(env, cq, ctx) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const telegramId = String(cq.from.id);
  const data = cq.data || '';

  if (data === 'spin') return answerCallbackQuery(env, cq.id);   // the button that is already spinning

  if (data.startsWith('menu:')) {
    await answerCallbackQuery(env, cq.id);
    if (!chatId) return;
    return routeTelegramMessage(env, {
      chat: { id: chatId }, from: cq.from, text: data.slice('menu:'.length), message_id: cq.message && cq.message.message_id, fromMenuButton: true,
    });
  }
  if (data.startsWith('gl:')) {
    return handleGameListCallback(env, cq);
  }
  if (data.startsWith('bg:')) {
    return handleBuyCallback(env, cq, ctx);
  }
  if (data.startsWith('faq:')) {
    return handleFaqCallback(env, cq);
  }
  if (data.startsWith('track:')) {
    return handleTrackOrderCallback(env, cq);
  }
  if (data.startsWith('ord:')) {
    return handleOrderDetailCallback(env, cq);
  }
  if (data.startsWith('acc:')) {
    return handleAccountEditCallback(env, cq);
  }

  if (data.startsWith('lang:')) {
    const lang = SUPPORTED_LANGS.includes(data.slice('lang:'.length)) ? data.slice('lang:'.length) : 'my';
    await setLanguage(env, telegramId, lang);
    await answerCallbackQuery(env, cq.id);
    // Remove the picker so the chat stays tidy, then confirm in the new language.
    if (cq.message && cq.message.message_id) {
      await tgPost(env, 'deleteMessage', { chat_id: chatId, message_id: cq.message.message_id }).catch(() => {});
    }
    return sendTelegramMessage(env, chatId, t(lang, 'languageSet'), MAIN_KEYBOARD);
  }

  // Quick-amount preset button ("5,000 MMK" etc.) tapped on the "enter
  // amount" step — same destination as typing the number in by hand.
  if (data.startsWith('topup_qty:')) {
    const amount = Number(data.slice('topup_qty:'.length));
    const [session, lang] = await Promise.all([getBotSession(env, telegramId), getLanguage(env, telegramId)]);
    if (!session || session.step !== 'awaiting_amount' || !amount) {
      await answerCallbackQuery(env, cq.id, t(lang, 'sessionGone'));
      return;
    }
    await answerCallbackQuery(env, cq.id);
    return proceedToMethodPicker(env, chatId, telegramId, amount);
  }

  // Next/Back tapped on the quick-amount grid — just re-draws this same
  // "enter amount" message with the requested page's presets, doesn't touch
  // the topup session or its text.
  if (data.startsWith('topup_qty_page:')) {
    const page = Number(data.slice('topup_qty_page:'.length));
    const messageId = cq.message && cq.message.message_id;
    const [session, lang] = await Promise.all([getBotSession(env, telegramId), getLanguage(env, telegramId)]);
    if (!session || session.step !== 'awaiting_amount' || Number.isNaN(page)) {
      await answerCallbackQuery(env, cq.id, t(lang, 'sessionGone'));
      return;
    }
    await answerCallbackQuery(env, cq.id);
    // Re-render the prompt in the current language (keeps quote formatting).
    const text = t(lang, 'topupPrompt', WALLET_TOPUP_MIN.toLocaleString(), WALLET_TOPUP_MAX.toLocaleString());
    return editTelegramMessage(env, chatId, messageId, text, quickAmountKeyboard(page, lang));
  }

  if (data.startsWith('topup_pm:')) {
    const pmId = data.slice('topup_pm:'.length);
    const session = await getBotSession(env, telegramId);
    if (!session || session.step !== 'awaiting_method' || !session.amount) {
      await answerCallbackQuery(env, cq.id, t(await getLanguage(env, telegramId), 'sessionGone'));
      return;
    }
    const methods = await listPaymentMethods(env);
    const method = methods.find((m) => m.id === pmId);
    if (!method) {
      await answerCallbackQuery(env, cq.id, t(await getLanguage(env, telegramId), 'methodNotFound'));
      return;
    }
    // Per-method amount limits — separate from the global WALLET_TOPUP_MIN/
    // MAX above. Optional paymentMethods/{id}.minAmount / .maxAmount fields
    // set in admin.html; a method with neither set has no extra limit here.
    // Shown as a popup alert (not just a toast) since missing it means the
    // customer sends a receipt for an amount that method can't take.
    if (typeof method.minAmount === 'number' && session.amount < method.minAmount) {
      await answerCallbackQuery(env, cq.id, t(await getLanguage(env, telegramId), 'methodMin', method.name, method.minAmount.toLocaleString()), true);
      return;
    }
    if (typeof method.maxAmount === 'number' && session.amount > method.maxAmount) {
      await answerCallbackQuery(env, cq.id, t(await getLanguage(env, telegramId), 'methodMax', method.name, method.maxAmount.toLocaleString()), true);
      return;
    }
    // Land on a confirm step rather than jumping straight to "send your
    // receipt" — lets a customer catch a wrong amount/method before we ask
    // them for a screenshot, instead of only being able to Cancel and
    // restart from scratch.
    await setBotSession(env, telegramId, {
      step: 'awaiting_confirm',
      amount: session.amount,
      paymentMethodName: method.name,
      paymentMethodNumber: method.number || '',
      paymentMethodAccountName: method.accountName || '',
    });
    await setLastPaymentMethod(env, telegramId, method.id, method.name);
    await answerCallbackQuery(env, cq.id);
    return sendTopupConfirmPrompt(env, chatId, session.amount, method.name, await getLanguage(env, telegramId));
  }

  // "✅ Confirm" on the amount+method summary — locks the flow in and moves
  // on to actually requesting the receipt photo.
  if (data === 'topup_confirm') {
    const session = await getBotSession(env, telegramId);
    if (!session || session.step !== 'awaiting_confirm' || !session.amount || !session.paymentMethodName) {
      await answerCallbackQuery(env, cq.id, t(await getLanguage(env, telegramId), 'sessionGone'));
      return;
    }
    const lang = await getLanguage(env, telegramId);
    const acct = await lookupAccountByTelegramId(env, telegramId);
    if (!acct) {
      await answerCallbackQuery(env, cq.id);
      await clearBotSession(env, telegramId);
      return sendTelegramMessage(env, chatId, t(lang, 'notConnected'), guestMarkup(lang));
    }
    await answerCallbackQuery(env, cq.id);
    // PIN / Authenticator first (if the customer enabled them), then the receipt prompt.
    return startTopupSecurityOrReceipt(env, chatId, telegramId, session, acct, lang);
  }

  // "✏️ Edit" on the confirm summary — offers a choice of what to fix
  // instead of guessing; each option routes to the existing back-to-amount
  // or back-to-method handlers below.
  if (data === 'topup_edit') {
    const session = await getBotSession(env, telegramId);
    if (!session || !session.amount) {
      await answerCallbackQuery(env, cq.id, t(await getLanguage(env, telegramId), 'sessionGone'));
      return;
    }
    await answerCallbackQuery(env, cq.id);
    const lang = await getLanguage(env, telegramId);
    return sendFlowMessage(
      env, chatId,
      t(lang, 'editPrompt'),
      cancelInlineKeyboard([
        [{ text: btn(lang, 'changeAmount'), callback_data: 'topup_back_amount' }],
        [{ text: btn(lang, 'changeMethod'), callback_data: 'topup_back_method' }],
      ], lang)
    );
  }

  // Shared "❌ Cancel" button — attached to every step of the wallet
  // top-up flow (amount / method / confirm / receipt), so this fires
  // regardless of which step the customer is currently on.
  if (data === 'topup_cancel') {
    const lang = await getLanguage(env, telegramId);
    await answerCallbackQuery(env, cq.id);
    // Delete every message of this flow (incl. the one whose button was
    // just tapped), then confirm with a fresh message that restores the
    // main reply keyboard.
    await cancelFlow(env, chatId, telegramId, [cq.message && cq.message.message_id]);
    return sendTelegramMessage(env, chatId, t(lang, 'cancelled'), MAIN_KEYBOARD);
  }

  // "🔙 Change Amount" — reachable from the confirm step and from the
  // receipt prompt. Unlike the old behavior (Cancel + restart from
  // scratch), this keeps the flow alive and just re-asks for the amount;
  // the payment method already picked is dropped since a new amount means
  // re-confirming the method anyway.
  if (data === 'topup_back_amount') {
    const session = await getBotSession(env, telegramId);
    if (!session) {
      await answerCallbackQuery(env, cq.id, t(await getLanguage(env, telegramId), 'sessionGone'));
      return;
    }
    await setBotSession(env, telegramId, { step: 'awaiting_amount' });
    const lang = await getLanguage(env, telegramId);
    await answerCallbackQuery(env, cq.id);
    return sendFlowMessage(
      env, chatId,
      t(lang, 'topupPrompt', WALLET_TOPUP_MIN.toLocaleString(), WALLET_TOPUP_MAX.toLocaleString()),
      quickAmountKeyboard(0, lang)
    );
  }

  // "🔙 Change Method" — reachable from the confirm step and from the
  // receipt prompt. Steps back to awaiting_method without losing the
  // amount already entered, instead of forcing a full restart via Cancel.
  if (data === 'topup_back_method') {
    const session = await getBotSession(env, telegramId);
    if (!session || !session.amount) {
      await answerCallbackQuery(env, cq.id, t(await getLanguage(env, telegramId), 'sessionGone'));
      return;
    }
    await setBotSession(env, telegramId, { step: 'awaiting_method', amount: session.amount });
    await answerCallbackQuery(env, cq.id);
    return sendPaymentMethodPicker(env, chatId, telegramId, session.amount);
  }

  // "🔄 ထပ်ကြိုးစားမည်" on a failed receipt upload — re-attempts the same
  // photo (its file_id was stashed on the session when the upload first
  // failed) instead of forcing the customer to re-send the screenshot or
  // restart the whole flow.
  if (data === 'topup_retry_receipt') {
    const session = await getBotSession(env, telegramId);
    if (!session || session.step !== 'awaiting_receipt' || !session.amount || !session.paymentMethodName || !session.lastReceiptFileId) {
      await answerCallbackQuery(env, cq.id, t(await getLanguage(env, telegramId), 'sessionGone'));
      return;
    }
    const acct = await lookupAccountByTelegramId(env, telegramId);
    if (!acct) {
      const lang = await getLanguage(env, telegramId);
      await answerCallbackQuery(env, cq.id);
      await clearBotSession(env, telegramId);
      return sendTelegramMessage(env, chatId, t(lang, 'notConnected'), guestMarkup(lang));
    }
    await answerCallbackQuery(env, cq.id);
    { const blocked = await botTopupSecurityBlocked(env, acct, session);
      if (blocked) {
        const lang = await getLanguage(env, telegramId);
        if (blocked === 'required') await clearBotSession(env, telegramId);
        return sendTelegramMessage(env, chatId, t(lang, blocked === 'required' ? 'secRequired' : 'secUnavailable'), MAIN_KEYBOARD);
      } }
    await sendFlowMessage(env, chatId, t(await getLanguage(env, telegramId), 'receiptProcessing'));
    return submitTopupReceipt(env, ctx, chatId, telegramId, session.lastReceiptFileId, session, acct, acct.name || acct.telegramUsername || acct.guestId);
  }
}

// Shown right before the receipt is requested — a last chance to catch a
// wrong amount or payment method (see FAQ_ITEMS-adjacent comment above:
// previously the only way back was Cancel + starting the whole flow over).
async function sendRichFlowCard(env, chatId, blocks, fallbackText, markup) {
  const id = await sendRichCard(env, chatId, blocks, fallbackText, markup);
  await trackFlowMessage(env, chatId, id);
  return id;
}

function receiptBlocks(lang, method, accName, number, amount) {
  const my = lang !== 'en';
  const hasNum = number && number !== '-';
  const rows = [
    [my ? '💳 နည်းလမ်း' : '💳 Method', method],
    [my ? '👤 အကောင့်အမည်' : '👤 Account name', accName || '-'],
    [my ? '📱 နံပါတ်' : '📱 Number', hasNum ? number : '-'],
    [my ? '💰 လွှဲရမည့်ပမာဏ' : '💰 Amount to send', `${amount} MMK`],
  ];
  const blocks = richTableBlocks(my ? '💳 ငွေလွှဲရန် အချက်အလက်' : '💳 Transfer details', rows, my);
  blocks.push(orPara(my
    ? `${hasNum ? '👆 အောက်က "ဖုန်းနံပါတ် Copy" ကိုနှိပ်ရင် နံပါတ်ကူးပြီးသား ဖြစ်ပါမယ်။\n' : ''}ငွေလွှဲပြီးရင် Receipt screenshot ကို ဒီ Chat ထဲ ပို့ပါ 📸`
    : `${hasNum ? '👆 Tap "Copy number" below to copy it.\n' : ''}After transferring, send your receipt screenshot in this chat 📸`));
  return blocks;
}

function sendTopupConfirmPrompt(env, chatId, amount, methodName, lang = 'my') {
  const my = lang !== 'en';
  const blocks = richTableBlocks(my ? '🧾 အတည်ပြုပါ' : '🧾 Please confirm', [
    [my ? '💰 ပမာဏ' : '💰 Amount', `${amount.toLocaleString()} MMK`],
    [my ? '💳 နည်းလမ်း' : '💳 Method', methodName],
  ], my);
  blocks.push(orPara(my ? 'မှန်ရင် ✅ အတည်ပြုမည် ကို နှိပ်ပါ။' : "If that's right, tap ✅ Confirm."));
  return sendRichFlowCard(
    env, chatId, blocks,
    t(lang, 'confirmPrompt', amount.toLocaleString(), methodName),
    cancelInlineKeyboard([
      [styled({ text: btn(lang, 'confirm'), callback_data: 'topup_confirm' }, 'success'), styled({ text: btn(lang, 'edit'), callback_data: 'topup_edit' }, 'primary')],
    ], lang)
  );
}

async function routeTelegramPhoto(env, msg, ctx) {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from.id);
  const lang = await getLanguage(env, telegramId);
  const session = await getBotSession(env, telegramId);
  if (session && session.step === 'buy_receipt') return handleBuyReceiptPhoto(env, msg, session, ctx);
  if (session && String(session.step || '').startsWith('buy_')) {
    await trackFlowMessage(env, chatId, msg.message_id);
    return sendFlowMessage(env, chatId, bt(lang, 'ပုံကို Payment နည်းလမ်းရွေးပြီး ငွေလွဲပြီးမှ ပို့ပါ။ အခု အဆင့်မှာ အပေါ်က ခလုတ်တွေကို သုံးပါ။', 'Send the photo only after choosing a Payment method and paying. For now, use the buttons above.'));
  }
  if (!session || session.step !== 'awaiting_receipt' || !session.amount || !session.paymentMethodName) {
    // Not silent anymore — an unexplained missing reply here reads as a
    // stuck/broken bot, especially right after a timeout auto-cleared the
    // flow.
    return sendTelegramMessage(env, chatId, t(lang, 'topupExpired'), MAIN_KEYBOARD);
  }

  const acct = await lookupAccountByTelegramId(env, telegramId);
  if (!acct) {
    await clearBotSession(env, telegramId);
    return sendTelegramMessage(env, chatId, t(lang, 'notConnected'), guestMarkup(lang));
  }

  // Same Security Code / Authenticator rule as the website: no receipt is accepted until it passed.
  { const blocked = await botTopupSecurityBlocked(env, acct, session);
    if (blocked) {
      if (blocked === 'required') await clearBotSession(env, telegramId);
      return sendTelegramMessage(env, chatId, t(lang, blocked === 'required' ? 'secRequired' : 'secUnavailable'), MAIN_KEYBOARD);
    } }

  // Tighter limit specifically on topup submissions — each one uploads a
  // photo, writes a walletTopups doc, and pings the admin worker, so this
  // guards against spammed/duplicate receipts far more than the general
  // message flood guard does.
  const topupLimit = await checkRateLimit(env, telegramId, 'topup_submit', { maxCount: 5, windowMs: 60 * 60 * 1000 });
  if (topupLimit.limited) {
    await clearBotSession(env, telegramId);
    const waitMins = Math.max(1, Math.ceil(topupLimit.retryAfterMs / 60000));
    return sendTelegramMessage(env, chatId, t(lang, 'topupRateLimited', waitMins), MAIN_KEYBOARD);
  }

  await trackFlowMessage(env, chatId, msg.message_id); // the receipt photo itself
  const photos = msg.photo; // smallest -> largest; take the largest
  const fileId = photos[photos.length - 1].file_id;
  const displayName = acct.name || acct.telegramUsername || msg.from.first_name || acct.guestId;
  await sendFlowMessage(env, chatId, t(lang, 'receiptProcessing'));
  return submitTopupReceipt(env, ctx, chatId, telegramId, fileId, session, acct, displayName);
}

// Uploads a receipt photo + writes the walletTopups doc. Shared by
// routeTelegramPhoto() (first attempt, right after the photo arrives) and
// the "🔄 ထပ်ကြိုးစားမည်" retry callback (re-attempts the same file_id,
// stashed on the session below when an attempt fails) — so a flaky ImgBB
// upload no longer forces the customer to re-send the screenshot or
// restart the whole top-up flow from scratch.
async function submitTopupReceipt(env, ctx, chatId, telegramId, fileId, session, acct, displayName) {
  const lang = await getLanguage(env, telegramId);
  try {
    const receiptUrl = await uploadTelegramPhotoToImgBB(env, fileId);

    const topupId = await fsCreateDoc(env, 'walletTopups', {
      amount: session.amount,
      paymentMethod: session.paymentMethodName,
      receiptUrl,
      status: 'Pending',
      timestamp: new Date(),
      userId: acct.guestId,
      userName: displayName,
      userPhone: '',
      // So telegram-worker.js (the admin bot) can DM the customer back in
      // *this* bot's chat once a human taps Confirm & Credit / Reject —
      // without this, the customer only ever sees their own "submitted"
      // message and never hears the result. Only set for top-ups made
      // through this bot's own chat flow (store.html's submitWalletTopup()
      // doesn't have a telegramId to attach).
      telegramId: String(telegramId),
    });
    await clearBotSession(env, telegramId);
    pingCouponWorker('topup', topupId, env).catch((e) => console.error('pingCouponWorker failed:', e));
    {
      const my = lang !== 'en';
      const blocks = richTableBlocks(my ? '✅ တောင်းဆိုမှု ပို့ပြီးပါပြီ' : '✅ Request sent', [
        [my ? '💰 ပမာဏ' : '💰 Amount', `${session.amount.toLocaleString()} MMK`],
        [my ? '💳 နည်းလမ်း' : '💳 Method', session.paymentMethodName],
        ['📌 Status', '🕐 Pending'],
      ], my);
      blocks.push(orPara(my ? 'Admin စစ်ပြီးတာနဲ့ Wallet ထဲ ငွေဝင်ပါမယ်၊ Bot ကလည်း အကြောင်းပြန်ပါမယ်။' : 'As soon as our admin checks it, the money goes into your Wallet and the bot will let you know.'));
      const rid = await sendOrderRich(env, chatId, blocks);
      if (rid) return rid;
    }
    return sendTelegramMessage(env, chatId, t(lang, 'topupSuccess', session.amount.toLocaleString()), MAIN_KEYBOARD);
  } catch (e) {
    console.error('submitTopupReceipt failed:', e);
    // Keep the flow alive (don't clear the session) and remember this
    // file_id so a tap on "🔄 Retry" can re-attempt the exact same photo
    // instead of asking the customer to find and re-send it.
    await setBotSession(env, telegramId, {
      step: 'awaiting_receipt',
      amount: session.amount,
      paymentMethodName: session.paymentMethodName,
      paymentMethodNumber: session.paymentMethodNumber || '',
      paymentMethodAccountName: session.paymentMethodAccountName || '',
      lastReceiptFileId: fileId,
      secOkAt: Number(session.secOkAt) || 0,
    });
    // Money-critical: a customer believes they just paid and the receipt
    // failed to save. Worth an immediate admin ping, unlike most other
    // best-effort failures in this file.
    if (ctx) ctx.waitUntil(alertAdmin(env, `Wallet topup receipt failed for telegramId ${telegramId}`, e));
    return sendFlowMessage(env, chatId, t(lang, 'receiptFailed'), {
      inline_keyboard: [
        [styled({ text: btn(lang, 'retry'), callback_data: 'topup_retry_receipt' }, 'primary')],
        [{ text: btn(lang, 'cancel'), callback_data: 'topup_cancel' }],
      ],
    });
  }
}

// ---------------------------------------------------------------------------
// Game List flow — category menu, paged group list, server picker, and the
// final "Open in App" hand-off. See the comment above GAME_LIST_CATEGORIES.
// ---------------------------------------------------------------------------
async function sendGameListCategoryMenu(env, chatId) {
  return sendTelegramMessage(
    env, chatId,
    '🎮 Game List\n\nဝန်ဆောင်မှု အမျိုးအစား ရွေးချယ်ပါ:',
    gameListCategoryMenuMarkup()
  );
}

function gameListCategoryMenuMarkup() {
  return {
    inline_keyboard: [[
      { text: GAME_LIST_CATEGORIES.topup, callback_data: 'gl:genre:topup' },
      { text: GAME_LIST_CATEGORIES.voucher, callback_data: 'gl:genre:voucher' },
    ]],
  };
}

// Genre filter-chip menu shown after Top Up/Voucher is picked: "All" plus
// one button per GAME_GENRES entry, 2 per row, with a back button to the
// Top Up/Voucher chooser.
function buildGenreMenuMarkup(cat) {
  const rows = [[{ text: '🗂️ All', callback_data: `gl:c:${cat}:all:0` }]];
  for (let i = 0; i < GAME_GENRES.length; i += 2) {
    const row = [{ text: GAME_GENRES[i].label, callback_data: `gl:c:${cat}:${GAME_GENRES[i].id}:0` }];
    if (GAME_GENRES[i + 1]) {
      row.push({ text: GAME_GENRES[i + 1].label, callback_data: `gl:c:${cat}:${GAME_GENRES[i + 1].id}:0` });
    }
    rows.push(row);
  }
  rows.push([{ text: '⬅️ Type', callback_data: 'gl:catmenu' }]);
  return { inline_keyboard: rows };
}

// One inline button per game group, one group per row (names can run long),
// a Prev/Next nav row when there's more than a page's worth, and a Category
// button back to the Top Up / Voucher chooser.
function buildGroupListPage(cat, genre, groups, page) {
  const start = page * GAME_LIST_PAGE_SIZE;
  const pageGroups = groups.slice(start, start + GAME_LIST_PAGE_SIZE);
  const rows = pageGroups.map((g, i) => [{
    text: g.ids.length > 1 ? `${g.name} (${g.ids.length})` : g.name,
    callback_data: `gl:g:${cat}:${genre}:${page}:${start + i}`,
  }]);
  const navRow = [];
  if (page > 0) navRow.push({ text: '⬅️ Prev', callback_data: `gl:c:${cat}:${genre}:${page - 1}` });
  if (start + GAME_LIST_PAGE_SIZE < groups.length) navRow.push({ text: '➡️ Next', callback_data: `gl:c:${cat}:${genre}:${page + 1}` });
  if (navRow.length) rows.push(navRow);
  rows.push([{ text: '⬅️ Genre', callback_data: `gl:genre:${cat}` }]);
  return { inline_keyboard: rows };
}

async function sendOpenAppMessage(env, chatId, messageId, label, gameId, backButton) {
  const url = `${STORE_URL}?game=${encodeURIComponent(gameId)}`;
  return editTelegramMessage(
    env, chatId, messageId,
    `🎮 ${label}\n\nအောက်က ခလုတ်ကို နှိပ်ပြီး Store App ထဲမှာ ဖွင့်ပါ:`,
    { inline_keyboard: [[{ text: `🚀 ${label} ဖွင့်မည်`, web_app: { url } }], [backButton]] }
  );
}

async function handleGameListCallback(env, cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const messageId = cq.message && cq.message.message_id;
  if (!chatId || !messageId) {
    return answerCallbackQuery(env, cq.id);
  }
  const parts = (cq.data || '').split(':'); // ['gl', kind, ...]
  const kind = parts[1];

  if (kind === 'catmenu') {
    await answerCallbackQuery(env, cq.id);
    return editTelegramMessage(env, chatId, messageId, '🎮 Game List\n\nဝန်ဆောင်မှု အမျိုးအစား ရွေးချယ်ပါ:', gameListCategoryMenuMarkup());
  }

  // 'genre' and 'c'/'g'/'s' all need the freshly-recomputed group list for
  // this category — nothing about this flow is cached in Firestore session
  // state, so every tap re-derives it from the live "games" collection.
  const cat = parts[2];
  if (cat !== 'topup' && cat !== 'voucher') {
    await answerCallbackQuery(env, cq.id);
    return editTelegramMessage(env, chatId, messageId, '🎮 Game List\n\nဝန်ဆောင်မှု အမျိုးအစား ရွေးချယ်ပါ:', gameListCategoryMenuMarkup());
  }
  const catLabel = GAME_LIST_CATEGORIES[cat];

  if (kind === 'genre') {
    await answerCallbackQuery(env, cq.id);
    return editTelegramMessage(env, chatId, messageId, `${catLabel}\n\nဂိမ်း Category ရွေးချယ်ပါ:`, buildGenreMenuMarkup(cat));
  }

  // 'c', 'g' and 's' all carry the selected genre ('all' or a GAME_GENRES
  // id) as their next segment, right after cat.
  const genre = parts[3];
  const genreLabel = genre === 'all' ? null : findGenre(genre);
  // An unrecognized genre (stale message from before this filter existed,
  // or a tampered callback_data) falls back to the genre picker rather than
  // silently showing an unfiltered list.
  if (genre !== 'all' && !genreLabel) {
    await answerCallbackQuery(env, cq.id);
    return editTelegramMessage(env, chatId, messageId, `${catLabel}\n\nဂိမ်း Category ရွေးချယ်ပါ:`, buildGenreMenuMarkup(cat));
  }
  const headerLabel = genreLabel ? `${catLabel} · ${genreLabel.label}` : catLabel;

  if (kind === 'c') {
    const page = parseInt(parts[4], 10) || 0;
    await answerCallbackQuery(env, cq.id);
    const [games, flags] = await Promise.all([listGamesRaw(env), getProviderFlags(env)]);
    const groups = buildGameGroupsForCategory(games, flags, cat, genre);
    if (!groups.length) {
      return editTelegramMessage(env, chatId, messageId, `${headerLabel}\n\nဂိမ်းစာရင်း မရှိသေးပါ။`, {
        inline_keyboard: [[{ text: '⬅️ Genre', callback_data: `gl:genre:${cat}` }]],
      });
    }
    return editTelegramMessage(
      env, chatId, messageId,
      `${headerLabel}\n\nဂိမ်းတစ်ခု ရွေးချယ်ပါ: (${groups.length})`,
      buildGroupListPage(cat, genre, groups, page)
    );
  }

  if (kind === 'g') {
    const page = parseInt(parts[4], 10) || 0;
    const idx = parseInt(parts[5], 10);
    await answerCallbackQuery(env, cq.id);
    const [games, flags] = await Promise.all([listGamesRaw(env), getProviderFlags(env)]);
    const groups = buildGameGroupsForCategory(games, flags, cat, genre);
    const group = groups[idx];
    if (!group) {
      return editTelegramMessage(env, chatId, messageId, 'ဤဂိမ်းကို မတွေ့ရှိပါ (list ပြောင်းသွားနိုင်ပါသည်)။ ပြန်ကြိုးစားပေးပါ။', {
        inline_keyboard: [[{ text: '⬅️ Genre', callback_data: `gl:genre:${cat}` }]],
      });
    }
    if (group.ids.length <= 1) {
      return sendOpenAppMessage(env, chatId, messageId, group.name, group.ids[0], { text: '⬅️ Back', callback_data: `gl:c:${cat}:${genre}:${page}` });
    }
    // Multi-server game (e.g. "Mobile Legends (9)") — list every
    // server/region variant so the person can pick the exact one before
    // the Mini App opens straight into it.
    const rows = group.servers.map((s, i) => [{ text: s, callback_data: `gl:s:${cat}:${genre}:${page}:${idx}:${i}` }]);
    rows.push([{ text: '⬅️ Back', callback_data: `gl:c:${cat}:${genre}:${page}` }]);
    return editTelegramMessage(env, chatId, messageId, `${group.name}\n\nServer / Region ရွေးချယ်ပါ:`, { inline_keyboard: rows });
  }

  if (kind === 's') {
    const page = parseInt(parts[4], 10) || 0;
    const idx = parseInt(parts[5], 10);
    const sIdx = parseInt(parts[6], 10);
    await answerCallbackQuery(env, cq.id);
    const [games, flags] = await Promise.all([listGamesRaw(env), getProviderFlags(env)]);
    const groups = buildGameGroupsForCategory(games, flags, cat, genre);
    const group = groups[idx];
    const gameId = group && group.ids[sIdx];
    if (!group || !gameId) {
      return editTelegramMessage(env, chatId, messageId, 'ဤ Server ကို မတွေ့ရှိပါ (list ပြောင်းသွားနိုင်ပါသည်)။ ပြန်ကြိုးစားပေးပါ။', {
        inline_keyboard: [[{ text: '⬅️ Genre', callback_data: `gl:genre:${cat}` }]],
      });
    }
    const label = group.servers[sIdx] || group.name;
    return sendOpenAppMessage(env, chatId, messageId, label, gameId, { text: '⬅️ Back', callback_data: `gl:g:${cat}:${genre}:${page}:${idx}` });
  }

  return answerCallbackQuery(env, cq.id);
}

// Reads all "games" docs, keeping only the fields this flow needs (mirrors
// store.html's GAMES/RAW_GAMES shape, minus images/packages/etc.).
async function listGamesRaw(env) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const res = await fetch(`${base}/games`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return [];
    const data = await res.json();
    const docs = data.documents || [];
    return docs.map((d) => {
      const f = d.fields;
      return {
        id: d.name.split('/').pop(),
        name: fsField(f, 'name') || '',
        serverName: fsField(f, 'serverName') || '',
        order: fsField(f, 'order'),
        fulfillProvider: fsField(f, 'fulfillProvider') || '',
        category: fsField(f, 'category') || '',
      };
    });
  } catch (e) {
    console.error('listGamesRaw failed:', e);
    return [];
  }
}

// Mirrors store.html's settings/providerFlags read: missing doc or any
// field other than an explicit `false` means that source is enabled.
async function getProviderFlags(env) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const res = await fetch(`${base}/settings/providerFlags`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return {};
    const doc = await res.json();
    if (!doc.fields) return {};
    const flags = {};
    ['g2bulk', 'fazercard', 'jcplays'].forEach((p) => {
      flags[p] = fsField(doc.fields, p) !== false;
    });
    return flags;
  } catch (e) {
    console.error('getProviderFlags failed:', e);
    return {};
  }
}

// Reads settings/adminBroadcast.secret from Firestore instead of requiring
// a `wrangler secret put ADMIN_BROADCAST_SECRET` — lets the admin set/rotate
// this straight from admin.html's Settings page (Admin Broadcast Secret
// card), no CLI/dashboard step needed. Falls back to the env var if the
// Firestore doc is missing/empty, so an existing wrangler-set secret keeps
// working during migration.
//
// Cached 5 min per warm isolate (this value changes rarely — an admin
// manually rotating it — so there's no need to re-read on every request the
// way a fast-changing value would). A rotated secret takes effect on this
// Worker within 5 min at worst. An in-flight promise is also cached (not
// just the resolved value) so a burst of concurrent requests hitting a cold
// isolate at the same moment all await the same single Firestore read
// instead of each firing their own.
let cachedBroadcastSecret = null;
let cachedBroadcastSecretAt = 0;
let broadcastSecretFetchPromise = null;
async function getAdminBroadcastSecret(env) {
  const now = Date.now();
  if (cachedBroadcastSecret !== null && now - cachedBroadcastSecretAt < 300000) {
    return cachedBroadcastSecret;
  }
  if (broadcastSecretFetchPromise) return broadcastSecretFetchPromise;

  broadcastSecretFetchPromise = (async () => {
    try {
      const token = await getFirestoreAccessToken(env);
      const projectId = firestoreProjectId(env);
      const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
      const res = await fetch(`${base}/settings/adminBroadcast`, { headers: { Authorization: `Bearer ${token}` } });
      const doc = res.ok ? await res.json() : null;
      const fromFirestore = doc && doc.fields ? fsField(doc.fields, 'secret') : '';
      cachedBroadcastSecret = fromFirestore || env.ADMIN_BROADCAST_SECRET || '';
    } catch (e) {
      console.error('getAdminBroadcastSecret failed:', e);
      cachedBroadcastSecret = env.ADMIN_BROADCAST_SECRET || '';
    }
    // A transient Firestore failure with no env fallback leaves the secret empty ("Not configured"
    // for every notify call). Only keep a real secret for the full 5 min; retry an empty one in ~15s.
    cachedBroadcastSecretAt = cachedBroadcastSecret ? Date.now() : Date.now() - 300000 + 15000;
    broadcastSecretFetchPromise = null;
    return cachedBroadcastSecret;
  })();

  return broadcastSecretFetchPromise;
}

// Same fulfillProvider -> source-family mapping as store.html's
// gameProviderFamily(), so a source the admin has toggled off in
// settings/providerFlags disappears from the bot's list too.
function gameProviderFamily(fulfillProvider) {
  if (fulfillProvider === 'g2bulk' || fulfillProvider === 'g2bulk_voucher') return 'g2bulk';
  if (fulfillProvider === 'fazercard' || fulfillProvider === 'fazercard_giftcard') return 'fazercard';
  if (fulfillProvider === 'jcplays') return 'jcplays';
  return null;
}

// Filters to the requested category (voucher/giftcard providers vs every
// other, direct top-up provider — same split as store.html's Home vs
// Voucher tab), sorts by the admin's `order` field then name, and groups
// same-named uploads together (store.html's groupGamesByName) so a game
// uploaded once per server/region collapses into one "Name (N)" entry
// whose servers list drives the picker in the 's' step above.
function buildGameGroupsForCategory(games, flags, cat, genre) {
  const wantVoucher = cat === 'voucher';
  const wantGenre = genre && genre !== 'all' ? genre : null;
  const filtered = games.filter((g) => {
    const family = gameProviderFamily(g.fulfillProvider);
    if (family && flags[family] === false) return false;
    const isVoucher = g.fulfillProvider === 'g2bulk_voucher' || g.fulfillProvider === 'fazercard_giftcard';
    if (isVoucher !== wantVoucher) return false;
    if (wantGenre && g.category !== wantGenre) return false;
    return true;
  });
  filtered.sort((a, b) => {
    const oa = typeof a.order === 'number' ? a.order : Infinity;
    const ob = typeof b.order === 'number' ? b.order : Infinity;
    if (oa !== ob) return oa - ob;
    return (a.name || '').localeCompare(b.name || '');
  });
  const order = [];
  const map = {};
  filtered.forEach((g) => {
    const key = (g.name || '').trim().toLowerCase();
    if (!map[key]) {
      map[key] = { name: g.name, ids: [], servers: [] };
      order.push(key);
    }
    map[key].ids.push(g.id);
    map[key].servers.push(g.serverName || g.name);
  });
  return order.map((key) => map[key]);
}

// ---------------------------------------------------------------------------
// Inline mode — @linngamestorebot <text> typed in any chat. Requires
// /setinline to have been enabled for the bot via BotFather (done
// separately, outside this file). Reuses buildGameGroupsForCategory's
// same filter/group rules as Game List/Available Games, merged across
// Top Up + Voucher, then substring-matched (name-startsWith ranked first)
// against the typed query. Each result's tap sends a message with an
// "Open Linn Game Store" link — inline-result buttons only support `url` (not
// `web_app`, which Telegram restricts to a normal chat with the bot), so
// this opens the deep link in a browser rather than as a Mini App; from
// inside the bot chat itself, Game List/Available Games still give the
// full in-app web_app experience.
// ---------------------------------------------------------------------------
async function handleInlineQuery(env, inlineQuery) {
  const query = (inlineQuery.query || '').trim();
  if (!query) return answerInlineQuery(env, inlineQuery.id, []);

  const [games, flags] = await Promise.all([listGamesRaw(env), getProviderFlags(env)]);
  const topup = buildGameGroupsForCategory(games, flags, 'topup', 'all').map((g) => ({ ...g, cat: 'topup' }));
  const voucher = buildGameGroupsForCategory(games, flags, 'voucher', 'all').map((g) => ({ ...g, cat: 'voucher' }));

  const seen = new Set();
  const merged = [];
  [...topup, ...voucher].forEach((g) => {
    const key = (g.name || '').trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      merged.push(g);
    }
  });

  const q = query.toLowerCase();
  const matches = merged
    .filter((g) => (g.name || '').toLowerCase().includes(q))
    .sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 20); // Telegram inline results are capped at 50; 20 is plenty for a search box

  const results = matches.map((g, i) => {
    const gameId = g.ids[0];
    const url = `${STORE_URL}?game=${gameId}`;
    const serverNote = g.ids.length > 1 ? ` · ${g.ids.length} servers` : '';
    return {
      type: 'article',
      id: `${gameId}-${i}`,
      title: g.name,
      description: `${GAME_LIST_CATEGORIES[g.cat]}${serverNote}`,
      input_message_content: { message_text: `🎮 ${g.name}\n\nဖွင့်ကြည့်ရန်: ${url}` },
      reply_markup: { inline_keyboard: [[{ text: '🚀 Open Linn Game Store', url }]] },
    };
  });

  return answerInlineQuery(env, inlineQuery.id, results);
}

async function answerInlineQuery(env, inlineQueryId, results) {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerInlineQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inline_query_id: inlineQueryId, results, cache_time: 30, is_personal: true }),
    });
  } catch (e) {
    console.error('answerInlineQuery failed:', e);
  }
}

async function editTelegramMessage(env, chatId, messageId, text, replyMarkup) {
  try {
    await loadIconOverrides(env);
    const useIcons = iconsActive();
    const iconMarkup = useIcons ? withButtonIcons(replyMarkup) : null;
    const q = extractQuotes(text);
    const emojiEntities = useIcons ? buildEmojiEntities(q.text) : null;
    const entities = mergeEntities(emojiEntities, q.entities);
    const base = { chat_id: chatId, message_id: messageId };
    const stripped = () => {
      const s = extractQuotes(stripConfiguredEmojis(text));
      const p = { ...base, text: s.text };
      if (s.entities.length) p.entities = s.entities;
      const mk = stripIconMarkup(replyMarkup);
      if (mk) p.reply_markup = mk;
      return p;
    };
    let payload;
    if (useIcons) {
      payload = { ...base, text: q.text };
      if (iconMarkup || replyMarkup) payload.reply_markup = iconMarkup || replyMarkup;
      if (entities) payload.entities = entities;
    } else {
      payload = stripped();
    }
    const res = await tgPost(env, 'editMessageText', payload);
    if (!res.ok && (iconMarkup || emojiEntities)) {
      const data = await res.json().catch(() => null);
      if (shouldFallBackToPlain(data)) {
        const r2 = await tgPost(env, 'editMessageText', stripped());
        if (r2.ok) iconsDisabledUntil = Date.now() + ICON_RETRY_MS;
        return r2.ok;
      }
    }
    return res.ok;
  } catch (e) {
    // Most common cause: "message is not modified" (double-tap on the same
    // button) or the message aged past Telegram's edit window — neither is
    // worth surfacing as an error to the user, the keyboard still works.
    console.error('editTelegramMessage failed:', e);
    return false;
  }
}

// Telegram keeps a tapped button "lit up" until the callback is answered, so the slow Firestore
// work below must never run before that. A callback can only be answered once: the first call
// wins, later ones for the same id are skipped (so the early blank answer in the webhook and the
// handlers' own answerCallbackQuery() calls never fight each other).
const ANSWERED_CALLBACKS = new Set();
const INSTANT_CALLBACK_RE = /^(menu:|gl:|bg:|faq:|track:|lang:|acc:|topup_cancel$|ord:pg:|ord:back)/;
async function answerCallbackQuery(env, callbackQueryId, text, showAlert) {
  if (ANSWERED_CALLBACKS.has(callbackQueryId)) return;
  ANSWERED_CALLBACKS.add(callbackQueryId);
  if (ANSWERED_CALLBACKS.size > 500) ANSWERED_CALLBACKS.clear();
  try {
    const payload = { callback_query_id: callbackQueryId };
    if (text) payload.text = text;
    if (showAlert) payload.show_alert = true;
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error('answerCallbackQuery failed:', e);
  }
}

// Downloads a Telegram-hosted photo (getFile -> file bytes) and uploads it
// straight to ImgBB's own API, so admin.html displays bot-submitted receipts
// identically to site-submitted ones (same "receiptUrl" shape, no admin-side
// changes needed).
//
// Used to go through the imgbb-functions proxy Worker instead (the same one
// store.html's client-side uploads use, added there specifically to keep the
// ImgBB key out of browser-visible code). That doesn't apply here - this file
// is itself a server-side Worker, nothing in it is ever sent to a browser -
// so routing through a second Worker only added a same-zone Worker-to-Worker
// call, which Cloudflare blocks by default with error 1042 unless a Service
// Binding is configured (a wrangler.toml/dashboard step easy to miss, and
// exactly what was silently missing here: uploadRes.json() was blowing up on
// the 1042 HTML error page with "Unexpected token 'e' ... is not valid
// JSON"). Calling ImgBB directly with its own IMGBB_API_KEY secret removes
// the extra hop - and the key is just as safe as a Worker secret here as it
// is inside imgbb-functions, since neither is ever visible to a client.
//
// Needs an IMGBB_API_KEY secret on THIS Worker (Cloudflare dashboard ->
// gamestore-auth-worker -> Settings -> Variables and Secrets -> add
// IMGBB_API_KEY, same value imgbb-functions already uses) - a plain secret,
// no Service Binding/Triggers step needed.
const IMGBB_API_ENDPOINT = 'https://api.imgbb.com/1/upload';
async function uploadTelegramPhotoToImgBB(env, fileId) {
  const fileInfoRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const fileInfo = await fileInfoRes.json();
  if (!fileInfo.ok) throw new Error('getFile failed');
  const filePath = fileInfo.result.file_path;

  const fileRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  const blob = await fileRes.blob();

  if (!env.IMGBB_API_KEY) throw new Error('IMGBB_API_KEY is not set on this Worker');

  const form = new FormData();
  form.append('image', blob, 'receipt.jpg');

  const uploadRes = await fetch(`${IMGBB_API_ENDPOINT}?key=${encodeURIComponent(env.IMGBB_API_KEY)}`, { method: 'POST', body: form });

  if (!uploadRes.ok) {
    // Read as text first — ImgBB can still return an HTML/plain-text error
    // page on a non-2xx, so calling .json() directly here is exactly what
    // produced the "is not valid JSON" crash reported by alertAdmin().
    const bodyText = await uploadRes.text();
    throw new Error(`Receipt upload failed (HTTP ${uploadRes.status}): ${bodyText.slice(0, 200)}`);
  }

  let data;
  try {
    data = await uploadRes.json();
  } catch {
    const bodyText = await uploadRes.text().catch(() => '');
    throw new Error(`Receipt upload returned non-JSON response: ${bodyText.slice(0, 200)}`);
  }

  if (!data.success) throw new Error(data.error?.message || 'Receipt upload failed');
  return data.data.url;
}

// Same "wake the order-approval Worker up now" ping store.html sends after
// saving a walletTopups doc — lets the admin bot notify + Confirm/Reject
// this bot-submitted top-up instantly instead of waiting for its next cron.
const COUPON_WORKER_URL = 'https://linnmanagebot.linngamestore.workers.dev';
// Worker -> Worker over a plain workers.dev URL is blocked by Cloudflare (error 1042), so this used to fail
// silently and the admin bot never heard about bot-submitted top-ups. Goes through the ORDER_WORKER Service
// Binding when it exists (same binding the in-bot buy flow already uses), and logs a failure instead of hiding it.
async function pingCouponWorker(type, id, env) {
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ type, id }),
  };
  let res;
  if (env && env.ORDER_WORKER && typeof env.ORDER_WORKER.fetch === 'function') {
    res = await env.ORDER_WORKER.fetch('https://order-worker.internal/ping', init);
  } else {
    res = await fetch(`${(env && env.ORDER_WORKER_URL) || COUPON_WORKER_URL}/ping`, init);
  }
  if (!res.ok) console.error('pingCouponWorker: order worker answered', res.status, '- add the ORDER_WORKER Service Binding (-> linnmanagebot)');
  return res;
}

// ---------------------------------------------------------------------------
// Bot conversation state ("telegramBotSessions/{telegramId}") + a live read
// of the store's "paymentMethods" collection, both via the same Firestore
// REST + service-account token already used above.
// ---------------------------------------------------------------------------
async function getBotSession(env, telegramId) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const res = await fetch(`${base}/telegramBotSessions/${telegramId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const doc = await res.json();
    if (!doc.fields) return null;

    const updatedAt = fsField(doc.fields, 'updatedAt');
    if (updatedAt instanceof Date && Date.now() - updatedAt.getTime() > SESSION_TIMEOUT_MS) {
      await cancelFlow(env, telegramId, telegramId); // abandoned flow — clean up so it doesn't linger (chat_id === user id in 1:1 chats)
      return null;
    }

    return {
      step: fsField(doc.fields, 'step'),
      amount: fsField(doc.fields, 'amount'),
      paymentMethodName: fsField(doc.fields, 'paymentMethodName'),
      paymentMethodNumber: fsField(doc.fields, 'paymentMethodNumber'),
      paymentMethodAccountName: fsField(doc.fields, 'paymentMethodAccountName'),
      lastReceiptFileId: fsField(doc.fields, 'lastReceiptFileId'),
      warned: fsField(doc.fields, 'warned'),
      buy: fsField(doc.fields, 'buy'),
      accField: fsField(doc.fields, 'accField'),
      secOkAt: fsField(doc.fields, 'secOkAt') || 0,
    };
  } catch (e) {
    console.error('getBotSession failed:', e);
    return null;
  }
}

async function setBotSession(env, telegramId, data) {
  try {
    await fsSetDoc(env, `telegramBotSessions/${telegramId}`, { ...data, updatedAt: new Date() });
  } catch (e) {
    console.error('setBotSession failed:', e);
  }
}

async function clearBotSession(env, telegramId) {
  try {
    await fsDeleteDoc(env, `telegramBotSessions/${telegramId}`);
    // Flow finished some other way (receipt submitted, order ID looked up…):
    // just forget the tracked ids — those messages stay in the chat.
    await fsDeleteDoc(env, `telegramFlowMsgs/${telegramId}`);
  } catch (e) {
    console.error('clearBotSession failed:', e);
  }
}

// How far ahead of SESSION_TIMEOUT_MS to warn a customer mid-flow (2
// minutes), and the warning text itself. Kept separate from MESSAGES since
// this is sent from a scheduled sweep rather than a reply to something the
// customer just did.
const SESSION_WARNING_LEAD_MS = 2 * 60 * 1000;
const SESSION_WARNING_TEXT = {
  my: '⏰ Top Up ကို နောက် ၂ မိနစ်အတွင်း မပြီးရင် အလိုလို ပယ်ဖျက်သွားပါမယ်။ ဆက်လုပ်မယ်ဆိုရင် အခုပဲ ဆက်လုပ်ပါ။',
  en: "⏰ Your top-up will be cancelled automatically in 2 minutes. If you're still going, carry on now.",
};

// Sent once a session actually hits SESSION_TIMEOUT_MS (as opposed to
// SESSION_WARNING_TEXT above, which fires a couple minutes before that).
const SESSION_EXPIRED_TEXT = {
  my: '⏳ ကြာသွားလို့ Top Up ကို ပယ်ဖျက်လိုက်ပါပြီ။ ➕ Top Up Wallet ကနေ ပြန်စလို့ရပါတယ်။',
  en: '⏳ It took too long, so the top-up was cancelled. You can start again anytime from ➕ Top Up Wallet.',
};

// Every telegramBotSessions doc, straight (paginated, like Firestore's
// default 300-doc page) — same GET-the-collection pattern as
// listPaymentMethods(), since this is a small, short-lived collection
// (only customers currently mid-topup have a doc here at all).
async function listBotSessionDocs(env) {
  const token = await getFirestoreAccessToken(env);
  const projectId = firestoreProjectId(env);
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const res = await fetch(`${base}/telegramBotSessions`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const data = await res.json();
  const docs = data.documents || [];
  return docs.map((d) => ({
    telegramId: d.name.split('/').pop(),
    step: fsField(d.fields, 'step'),
    updatedAt: fsField(d.fields, 'updatedAt'),
    warned: fsField(d.fields, 'warned'),
  }));
}

// Cron sweep (see the `scheduled` export above): finds wallet-topup
// sessions that are within SESSION_WARNING_LEAD_MS of the 12-minute
// SESSION_TIMEOUT_MS and haven't already been warned, DMs each one a
// "⏰ 2 minutes left" heads-up, then marks the session `warned: true` so
// the same session doesn't get warned twice. Already-expired sessions are
// left alone here — they're cleaned up lazily the next time getBotSession()
// is called for that user (see the SESSION_TIMEOUT_MS check up there).
async function warnExpiringTopupSessions(env, ctx) {
  try {
    const sessions = await listBotSessionDocs(env);
    const now = Date.now();
    for (const s of sessions) {
      if (!s.step || s.warned || !(s.updatedAt instanceof Date)) continue;
      const ageMs = now - s.updatedAt.getTime();
      const msLeft = SESSION_TIMEOUT_MS - ageMs;
      if (msLeft <= 0 || msLeft > SESSION_WARNING_LEAD_MS) continue; // not expired, but not in the warning window either

      try {
        const lang = await getLanguage(env, s.telegramId);
        // For a 1:1 bot chat, chat_id === the user's own Telegram id — same
        // assumption already used by /notify-order-status elsewhere in this
        // file, so no extra chatId lookup is needed here.
        const isBuy = String(s.step || '').startsWith('buy_');
        await sendFlowMessage(env, s.telegramId, isBuy
          ? (lang === 'en' ? '⏰ Your purchase will be cancelled automatically in 2 minutes. Carry on now if you are still going.' : '⏰ ဝယ်ယူမှုကို နောက် ၂ မိနစ်အတွင်း မပြီးရင် အလိုလို ပယ်ဖျက်သွားပါမယ်။')
          : (SESSION_WARNING_TEXT[lang] || SESSION_WARNING_TEXT.my));
        await fsMergeDoc(env, `telegramBotSessions/${s.telegramId}`, { warned: true });
      } catch (e) {
        // One customer's failed warning shouldn't stop the rest of the sweep.
        console.error(`warnExpiringTopupSessions: failed for ${s.telegramId}:`, e);
      }
    }
  } catch (e) {
    console.error('warnExpiringTopupSessions failed:', e);
    if (ctx) ctx.waitUntil(alertAdmin(env, 'warnExpiringTopupSessions sweep failed', e));
  }
}

// Cron sweep companion to warnExpiringTopupSessions() above: once a session
// actually reaches SESSION_TIMEOUT_MS (rather than just approaching it),
// this clears it AND actively DMs the customer "Session Expired" — instead
// of leaving expiry as a silent, lazy cleanup that only happens next time
// getBotSession() is called for that user (which may be never, if they
// never come back). Run right after the warning sweep in `scheduled`.
async function expireStaleTopupSessions(env, ctx) {
  try {
    const sessions = await listBotSessionDocs(env);
    const now = Date.now();
    for (const s of sessions) {
      if (!s.step || !(s.updatedAt instanceof Date)) continue;
      const ageMs = now - s.updatedAt.getTime();
      if (ageMs < SESSION_TIMEOUT_MS) continue; // not expired yet

      try {
        const lang = await getLanguage(env, s.telegramId);
        await cancelFlow(env, s.telegramId, s.telegramId); // also removes the dead prompts/buttons
        // Same chat_id === telegramId assumption used everywhere else in
        // this file for 1:1 bot DMs.
        await sendTelegramMessage(env, s.telegramId, String(s.step || '').startsWith('buy_')
          ? (lang === 'en' ? '⏳ It took too long, so the purchase was cancelled. Start again from Game List.' : '⏳ ကြာသွားလို့ ဝယ်ယူမှုကို ပယ်ဖျက်လိုက်ပါပြီ။ Game List ကနေ ပြန်စလို့ရပါတယ်။')
          : (SESSION_EXPIRED_TEXT[lang] || SESSION_EXPIRED_TEXT.my), MAIN_KEYBOARD);
      } catch (e) {
        // One customer's failed expiry DM shouldn't stop the rest of the sweep.
        console.error(`expireStaleTopupSessions: failed for ${s.telegramId}:`, e);
      }
    }
  } catch (e) {
    console.error('expireStaleTopupSessions failed:', e);
    if (ctx) ctx.waitUntil(alertAdmin(env, 'expireStaleTopupSessions sweep failed', e));
  }
}

// Per-user bot preferences ("telegramBotPrefs/{telegramId}") — kept separate
// from telegramBotSessions (short-lived flow state) and telegramBotUsers
// (broadcast audience, rewritten wholesale on every /start) so remembering a
// payment method doesn't interact with either of those.
async function getLastPaymentMethod(env, telegramId) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const res = await fetch(`${base}/telegramBotPrefs/${telegramId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const doc = await res.json();
    if (!doc.fields) return null;
    const id = fsField(doc.fields, 'lastPaymentMethodId');
    const name = fsField(doc.fields, 'lastPaymentMethodName');
    return id ? { id, name } : null;
  } catch (e) {
    console.error('getLastPaymentMethod failed:', e);
    return null;
  }
}

async function setLastPaymentMethod(env, telegramId, methodId, methodName) {
  try {
    await fsMergeDoc(env, `telegramBotPrefs/${telegramId}`, {
      lastPaymentMethodId: methodId,
      lastPaymentMethodName: methodName,
      updatedAt: new Date(),
    });
  } catch (e) {
    console.error('setLastPaymentMethod failed:', e);
  }
}

// Language preference, stored on the same telegramBotPrefs doc as the
// last-used payment method (via fsMergeDoc, so the two never clobber each
// other). Defaults to Burmese — this bot's original/primary audience —
// for anyone who hasn't explicitly picked English with /language.
const SUPPORTED_LANGS = ['my', 'en'];
async function getLanguage(env, telegramId) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const res = await fetch(`${base}/telegramBotPrefs/${telegramId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return 'my';
    const doc = await res.json();
    const lang = doc.fields && fsField(doc.fields, 'language');
    return SUPPORTED_LANGS.includes(lang) ? lang : 'my';
  } catch (e) {
    console.error('getLanguage failed:', e);
    return 'my';
  }
}

async function setLanguage(env, telegramId, lang) {
  try {
    await fsMergeDoc(env, `telegramBotPrefs/${telegramId}`, { language: lang, updatedAt: new Date() });
  } catch (e) {
    console.error('setLanguage failed:', e);
  }
}

// Simple fixed-window rate limiter, stored per (telegramId, action) in
// "telegramRateLimits/{telegramId}_{action}". Not perfectly atomic (a
// read-then-write race under heavy concurrency could let a couple of extra
// requests slip through), which is fine here — this is an abuse guard, not
// a billing meter. Fails OPEN on any Firestore error: a real user should
// never get blocked because a rate-limit check itself broke.
// Returns { limited, retryAfterMs } instead of a plain boolean so a caller
// can tell the customer a concrete wait time ("try again in ~N minutes")
// instead of a vague "please wait". retryAfterMs is only meaningful when
// limited is true (time left until this fixed window resets).
async function checkRateLimit(env, telegramId, action, { maxCount, windowMs }) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const docId = `${telegramId}_${action}`;
    const res = await fetch(`${base}/telegramRateLimits/${docId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const now = Date.now();
    let windowStart = now;
    let count = 0;
    if (res.ok) {
      const doc = await res.json();
      if (doc.fields) {
        const ws = fsField(doc.fields, 'windowStart');
        if (ws instanceof Date && now - ws.getTime() < windowMs) {
          windowStart = ws.getTime();
          count = fsField(doc.fields, 'count') || 0;
        }
      }
    }
    count += 1;
    await fsSetDoc(env, `telegramRateLimits/${docId}`, { windowStart: new Date(windowStart), count });
    const limited = count > maxCount;
    return { limited, retryAfterMs: limited ? Math.max(0, windowStart + windowMs - now) : 0 };
  } catch (e) {
    console.error('checkRateLimit failed:', e);
    // Fails OPEN on any Firestore error: a real user should never get
    // blocked because a rate-limit check itself broke.
    return { limited: false, retryAfterMs: 0 };
  }
}

// Thin boolean wrapper over checkRateLimit() for the one caller (the
// general message flood guard) that doesn't need the wait time.
async function isRateLimited(env, telegramId, action, opts) {
  const { limited } = await checkRateLimit(env, telegramId, action, opts);
  return limited;
}

async function listPaymentMethods(env) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const res = await fetch(`${base}/paymentMethods`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return [];
    const data = await res.json();
    const docs = data.documents || [];
    return docs
      .map((d) => {
        const f = d.fields;
        return {
          id: d.name.split('/').pop(),
          name: fsField(f, 'name'),
          number: fsField(f, 'number'),
          accountName: fsField(f, 'accountName'),
          order: fsField(f, 'order'),
          // admin.html's "Availability Note" field (e.g. "⚡ Instant, 24/7")
          // and optional per-method min/max top-up amounts. Rename these
          // fsField() keys if admin.html actually writes them under
          // different field names.
          availabilityNote: cleanAvailabilityNote(fsField(f, 'availabilityNote')),
          minAmount: fsField(f, 'minAmount'),
          maxAmount: fsField(f, 'maxAmount'),
        };
      })
      .filter((m) => m.name)
      .sort((a, b) => {
        if (typeof a.order === 'number' && typeof b.order === 'number') return a.order - b.order;
        if (typeof a.order === 'number') return -1;
        if (typeof b.order === 'number') return 1;
        return (a.name || '').localeCompare(b.name || '');
      });
  } catch (e) {
    console.error('listPaymentMethods failed:', e);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Minimal Firestore REST write helpers (the rest of this file only ever
// read Firestore before now). Values -> Firestore's typed-field wire format.
// ---------------------------------------------------------------------------
function toFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  return { stringValue: String(v) };
}

function toFsFields(data) {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFsValue(v)]));
}

async function fsCreateDoc(env, collectionPath, data) {
  const token = await getFirestoreAccessToken(env);
  const projectId = firestoreProjectId(env);
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const res = await fetch(`${base}/${collectionPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: toFsFields(data) }),
  });
  const doc = await res.json();
  if (!res.ok) throw new Error((doc.error && doc.error.message) || 'Firestore create failed');
  return doc.name.split('/').pop();
}

// Atomically "claims" an update_id by creating a doc with that exact ID.
// Firestore's createDocument?documentId=<id> is atomic — if the doc already
// exists it returns 409 ALREADY_EXISTS instead of overwriting. That gives
// idempotency without a read-then-write race (two retried deliveries hitting
// this at the same instant can't both "win").
// Returns true the first time an update_id is seen, false on any repeat.
// `expireAt` is set 2 days out for an optional Firestore TTL policy on that
// field (Console > Firestore > TTL) so this collection doesn't grow forever;
// harmless to leave unset if no TTL policy is configured.
async function claimUpdateOnce(env, updateId) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const expireAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const res = await fetch(
      `${base}/telegramProcessedUpdates?documentId=${encodeURIComponent(String(updateId))}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fields: toFsFields({ processedAt: new Date(), expireAt }) }),
      }
    );
    if (res.status === 409) return false; // already processed
    if (!res.ok) {
      // 401/403/5xx etc. is a Firestore problem, NOT proof the update was already handled.
      // Returning false here made the bot silently ignore every message while Firestore was
      // unhappy. Fail open (same policy as the catch below): a duplicate beats a lost message.
      console.error('claimUpdateOnce: unexpected status', res.status);
      return true;
    }
    return true;
  } catch (e) {
    // If Firestore is unreachable, fail open (process the update) rather
    // than silently dropping real messages — a duplicate is far less bad
    // than a lost one.
    console.error('claimUpdateOnce failed:', e);
    return true;
  }
}

async function fsSetDoc(env, docPath, data) {
  const token = await getFirestoreAccessToken(env);
  const projectId = firestoreProjectId(env);
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const res = await fetch(`${base}/${docPath}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: toFsFields(data) }),
  });
  if (!res.ok) throw new Error('Firestore set failed');
}

// Partial update: unlike fsSetDoc (which replaces the whole document with
// just the given fields), this only touches the listed fields via Firestore's
// updateMask, leaving any other fields on the doc untouched. Needed for
// telegramBotPrefs, which now holds both lastPaymentMethod* and language —
// writing one with a full-document fsSetDoc would silently erase the other.
async function fsMergeDoc(env, docPath, data) {
  const token = await getFirestoreAccessToken(env);
  const projectId = firestoreProjectId(env);
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const mask = Object.keys(data).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const res = await fetch(`${base}/${docPath}?${mask}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: toFsFields(data) }),
  });
  if (!res.ok) throw new Error('Firestore merge failed');
}

async function fsDeleteDoc(env, docPath) {
  const token = await getFirestoreAccessToken(env);
  const projectId = firestoreProjectId(env);
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  await fetch(`${base}/${docPath}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
}

async function sendTelegramMessage(env, chatId, text, replyMarkup, parseMode) {
  await loadIconOverrides(env);
  const useIcons = iconsActive();
  const iconMarkup = useIcons ? withButtonIcons(replyMarkup) : null;
  const q = parseMode ? { text: stripQuoteMarkers(text), entities: [] } : extractQuotes(text);
  const emojiEntities = useIcons && !parseMode ? buildEmojiEntities(q.text) : null;
  const entities = mergeEntities(emojiEntities, q.entities);
  const base = { chat_id: chatId };
  if (parseMode) base.parse_mode = parseMode;
  // Text + keyboard with every premium-configured emoji removed (used when
  // icons are known to be unavailable, or as the retry after a rejection).
  const stripped = () => {
    const s = parseMode ? q : extractQuotes(stripConfiguredEmojis(text));
    const p = { ...base, text: s.text };
    if (s.entities.length) p.entities = s.entities;
    const mk = stripIconMarkup(replyMarkup);
    if (mk) p.reply_markup = mk;
    return p;
  };
  try {
    let payload;
    if (useIcons) {
      payload = { ...base, text: q.text };
      if (iconMarkup || replyMarkup) payload.reply_markup = iconMarkup || replyMarkup;
      if (entities) payload.entities = entities;
    } else {
      payload = stripped();
    }
    let res = await tgPost(env, 'sendMessage', payload);
    let data = await res.json().catch(() => null);
    if (!res.ok && (iconMarkup || emojiEntities) && shouldFallBackToPlain(data)) {
      // Most likely the bot owner has no Telegram Premium — resend without
      // the premium emoji instead of losing the message.
      console.error('sendTelegramMessage: custom emoji rejected, retrying without:', data && data.description);
      res = await tgPost(env, 'sendMessage', stripped());
      data = await res.json().catch(() => null);
      if (res.ok) iconsDisabledUntil = Date.now() + ICON_RETRY_MS;
    }
    if (!res.ok) console.error('sendTelegramMessage: Telegram error', res.status, data && data.description, 'chat', chatId);
    return data && data.result ? data.result.message_id : undefined;
  } catch (e) {
    console.error('sendTelegramMessage failed:', e);
  }
}

// Sends a DM to the admin's own Telegram chat when something that actually
// matters breaks (an unhandled request error, or a wallet-topup receipt that
// failed to save) — the previous behavior was console.error only, which
// nobody sees until they go looking in the Cloudflare dashboard logs. Most
// of the ~20 other console.error calls in this file are deliberately left
// alone: best-effort side actions (a failed sendMessage, a failed session
// write) that shouldn't page anyone every time a Telegram/Firestore call
// hiccups. env.ADMIN_TELEGRAM_CHAT_ID is optional — if unset this is a
// silent no-op, so nothing breaks for anyone who hasn't configured it yet.
// (For a 1:1 bot chat, chat_id === that admin's own Telegram user id.)
async function alertAdmin(env, label, err) {
  if (!env.ADMIN_TELEGRAM_CHAT_ID) return;
  const detail = err instanceof Error ? err.message : String(err || '');
  const text = `🚨 Linn Game Store bot error\n\n${label}\n\n${detail}`.slice(0, 1000);

  // Unlike sendTelegramMessage() (best-effort, swallows failures — fine for
  // routine customer replies), an admin alert is itself the thing telling
  // us something broke, so a Telegram API hiccup or transient rate-limit
  // shouldn't just silently drop it. Retry a few times with backoff before
  // giving up.
  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.ADMIN_TELEGRAM_CHAT_ID, text }),
      });
      if (res.ok) return;
      // Telegram's 429 responses include a retry_after (seconds) — honor it
      // instead of guessing a backoff.
      let retryAfterMs = 500 * (i + 1);
      if (res.status === 429) {
        const body = await res.json().catch(() => null);
        const retryAfterSec = body && body.parameters && body.parameters.retry_after;
        if (retryAfterSec) retryAfterMs = retryAfterSec * 1000 + 200;
      }
      console.error(`alertAdmin: sendMessage failed (attempt ${i + 1}/${attempts}), status ${res.status}`);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, retryAfterMs));
    } catch (e) {
      console.error(`alertAdmin: sendMessage threw (attempt ${i + 1}/${attempts}):`, e);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  console.error('alertAdmin: giving up after all retries — admin alert was lost:', label);
}

// ---------------------------------------------------------------------------
// Firestore access via a Google OAuth2 service-account token (JWT bearer
// flow) — separate from the Firebase custom-token minting above, but reuses
// the same private key / client email and the same importPrivateKey().
//
// Cached at module scope: Cloudflare keeps a Worker's top-level state alive
// across requests on the same warm isolate, so a token minted for one
// button tap is reused by the next one instead of re-minting (and making an
// extra oauth2.googleapis.com round trip) on every single Firestore call.
// Google tokens are valid 1h; refreshed 2 min before expiry.
// ---------------------------------------------------------------------------
let cachedFirestoreToken = null;
let cachedFirestoreTokenExpiry = 0;

function firestoreProjectId(env) {
  // Service account emails look like name@PROJECT_ID.iam.gserviceaccount.com
  const m = env.FIREBASE_CLIENT_EMAIL.match(/@([^.]+)\.iam\.gserviceaccount\.com/);
  return m ? m[1] : '';
}

async function getFirestoreAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedFirestoreToken && now < cachedFirestoreTokenExpiry - 120) {
    return cachedFirestoreToken;
  }

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const encHeader = base64url(JSON.stringify(header));
  const encPayload = base64url(JSON.stringify(payload));
  const unsigned = `${encHeader}.${encPayload}`;
  const key = await importPrivateKey(env.FIREBASE_PRIVATE_KEY);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, strToBuf(unsigned));
  const jwt = `${unsigned}.${base64urlFromBuf(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  const data = await res.json();
  cachedFirestoreToken = data.access_token;
  cachedFirestoreTokenExpiry = now + (Number(data.expires_in) || 3600);
  return cachedFirestoreToken;
}

function fsField(fields, key) {
  const f = fields && fields[key];
  if (!f) return undefined;
  if ('stringValue' in f) return f.stringValue;
  if ('integerValue' in f) return Number(f.integerValue);
  if ('doubleValue' in f) return f.doubleValue;
  if ('booleanValue' in f) return f.booleanValue;
  if ('timestampValue' in f) return new Date(f.timestampValue);
  return undefined;
}

// telegramId -> guestId is remembered for a minute per isolate, so a warm button tap skips the first Firestore hop
// (every tap used to do link doc -> user doc one after the other). Safe: the users/{guestId} read below still happens
// every time (balance etc. are never cached); if that doc is gone the cache entry is dropped and the full lookup reruns.
const _ACCT_GID_CACHE = new Map();
const ACCT_GID_TTL_MS = 60 * 1000;

async function lookupAccountByTelegramId(env, telegramId, _fresh) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const key = String(telegramId);

    let guestId = null, fromCache = false;
    const hit = !_fresh && _ACCT_GID_CACHE.get(key);
    if (hit && Date.now() - hit.at < ACCT_GID_TTL_MS) { guestId = hit.guestId; fromCache = true; }
    if (!guestId) {
      const linkRes = await fetch(`${base}/telegramAccounts/tg_${telegramId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!linkRes.ok) { _ACCT_GID_CACHE.delete(key); return null; }
      const linkDoc = await linkRes.json();
      guestId = fsField(linkDoc.fields, 'guestId');
      if (!guestId) return null;
      if (_ACCT_GID_CACHE.size > 2000) _ACCT_GID_CACHE.clear();
      _ACCT_GID_CACHE.set(key, { guestId, at: Date.now() });
    }

    const userRes = await fetch(`${base}/users/${guestId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) {
      _ACCT_GID_CACHE.delete(key);
      return fromCache ? lookupAccountByTelegramId(env, telegramId, true) : null;
    }
    const userDoc = await userRes.json();
    const f = userDoc.fields;
    return {
      guestId,
      name: fsField(f, 'name'),
      telegramUsername: fsField(f, 'telegramUsername'),
      phone: fsField(f, 'phone'),
      email: fsField(f, 'contactEmail'),   // contact email (website: users/{id}.contactEmail) — NOT login emails (googleEmail / linkedEmail ...)
      walletBalance: fsField(f, 'walletBalance') || 0,
      createdAt: fsField(f, 'createdAt'),
    };
  } catch (e) {
    console.error('lookupAccountByTelegramId failed:', e);
    return null;
  }
}

// Looks up a single order by its exact document ID (unlike
// lookupRecentOrders, which only returns the 5 most recent) — used by both
// "🔍 Track my order" and the "🧾 details" button under 📦 My Orders.
// Callers MUST check the returned order's `userId` against the requesting
// account's guestId before showing it — this function itself does no
// ownership check, so a raw call here would let anyone view any order by
// guessing its ID.
async function lookupOrderById(env, orderId) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const res = await fetch(`${base}/orders/${encodeURIComponent(orderId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const doc = await res.json();
    if (!doc.fields) return null;
    const f = doc.fields;
    return {
      id: orderId,
      userId: fsField(f, 'userId'),
      game: fsField(f, 'game'),
      price: fsField(f, 'price') || 0,
      status: fsField(f, 'status'),
      timestamp: fsField(f, 'timestamp'),
      // Optional — only present if the "orders" doc happens to carry them;
      // buildOrderDetailText() drops whichever of these come back undefined.
      paymentMethod: fsField(f, 'paymentMethod'),
      note: fsField(f, 'note'),
      receiptUrl: fsField(f, 'receiptUrl'),
      itemAmount: fsField(f, 'itemAmount'),
      quantity: fsField(f, 'quantity'),
      playerId: fsField(f, 'playerId'),
      serverId: fsField(f, 'serverId'),
      charName: fsField(f, 'charName'),
    };
  } catch (e) {
    console.error('lookupOrderById failed:', e);
    return null;
  }
}

async function lookupRecentOrders(env, guestId, offset = 0, limit = 5) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
    const body = {
      structuredQuery: {
        from: [{ collectionId: 'orders' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'userId' },
            op: 'EQUAL',
            value: { stringValue: guestId },
          },
        },
        orderBy: [{ field: { fieldPath: 'timestamp' }, direction: 'DESCENDING' }],
        limit,
        ...(offset > 0 ? { offset } : {}),
      },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const rows = await res.json();
    return rows
      .filter((r) => r.document)
      .map((r) => {
        const f = r.document.fields;
        return {
          id: r.document.name.split('/').pop(),
          game: fsField(f, 'game'),
          price: fsField(f, 'price') || 0,
          status: fsField(f, 'status'),
          timestamp: fsField(f, 'timestamp'),
        };
      });
  } catch (e) {
    console.error('lookupRecentOrders failed:', e);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Connected-status push — tells the user (via the same bot) that their
// Telegram login is now linked, with User ID / Name / Balance / Connected
// Time. Called from index.html right after a first-time link succeeds.
// Body: { telegramId, guestId, name, balance }
// Best-effort: a Telegram API failure here must never block the sign-in
// flow that calls it, so this always returns 200 unless the payload itself
// is invalid.
// ---------------------------------------------------------------------------
// Proves the caller is really signed in as this Telegram user: the storefront
// sends its Firebase ID token (Authorization: Bearer ...) and we ask Firebase
// Auth who it belongs to. The custom-token uid is `tg_<telegramId>`, so the
// token's uid must match the telegramId in the body. Without this anyone could
// make the bot send a fake "connected / balance" message to any customer.
// (The Firebase web API key is public - it is already in store.html.)
const FIREBASE_WEB_API_KEY_FALLBACK = 'AIzaSyC9soIo8J-NP5bc4STi_eOB1oP94IvcOL8';
// Prefer the Worker variable FIREBASE_WEB_API_KEY (so the key is not tied to this file). The key is public, but in the
// Google Cloud console restrict it to your own domains and keep Firestore rules tight.
let _fbKeyWarned = false;
function firebaseWebKey(env) {
  if (env && env.FIREBASE_WEB_API_KEY) return env.FIREBASE_WEB_API_KEY;
  if (!_fbKeyWarned) { _fbKeyWarned = true; console.warn('FIREBASE_WEB_API_KEY is not set - using the built-in fallback key'); }
  return FIREBASE_WEB_API_KEY_FALLBACK;
}
async function verifyTelegramIdToken(request, env, telegramId) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  try {
    const key = firebaseWebKey(env);
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: m[1].trim() }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    const uid = data && data.users && data.users[0] && data.users[0].localId;
    return !!uid && uid === 'tg_' + String(telegramId);
  } catch (e) {
    console.error('verifyTelegramIdToken failed:', e);
    return false;
  }
}

async function handleNotifyConnected(request, env, corsHeaders) {
  const body = await safeJson(request);
  const telegramId = body && body.telegramId;
  if (!telegramId || !/^[0-9]{1,15}$/.test(String(telegramId))) return json({ error: 'Missing telegramId' }, 400, corsHeaders);
  if (!(await verifyTelegramIdToken(request, env, telegramId))) {
    return json({ error: 'Unauthorized' }, 401, corsHeaders);
  }

  const guestId = body.guestId ? String(body.guestId).slice(0, 40) : '-';
  const name = body.name ? String(body.name).slice(0, 60) : '-';
  const balance = Number.isFinite(Number(body.balance)) ? Number(body.balance) : 0;

  const connectedTime = new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Yangon',
    hour12: false,
  }) + ' (Yangon)';

  const text =
    `✅ Telegram ချိတ်ဆက်မှု အောင်မြင်ပါပြီ!\n\n` +
    `သင့် Telegram Account ကို Linn Game Store နဲ့ ချိတ်ဆက်ပြီးပါပြီ။\n\n` +
    `🆔 User ID: ${guestId}\n` +
    `👤 Name: ${name}\n` +
    `💼 Wallet လက်ကျန်: ${balance.toLocaleString()} MMK\n` +
    `🕐 ချိတ်ဆက်ချိန်: ${connectedTime}\n\n` +
    `အခု အောက်က Menu ခလုတ်တွေ သုံးလို့ရပါပြီ 👇\n` +
    `💼 Wallet — လက်ကျန်ငွေ ကြည့်ရန်၊ ငွေဖြည့်ရန်\n` +
    `📦 My Orders — Order အခြေအနေ ကြည့်ရန်\n` +
    `📱 Official Mini App — Game ရွေးဝယ်ရန်\n\n` +
    `💡 Game ဝယ်ဖို့ Wallet ထဲ ငွေရှိရပါမယ်။ လက်ကျန် မရှိသေးရင် 💼 Wallet ကိုနှိပ်ပြီး ➕ Top Up Wallet ကနေ အရင်ဖြည့်ပါ။\n` +
    `🔒 ဒီ Account မဟုတ်ဘူးဆိုရင် (သို့) ကိုယ်တိုင် မချိတ်ခဲ့ဘူးဆိုရင် 💬 Help Center ကနေ Support ကို ချက်ချင်း ဆက်သွယ်ပါ။`;

  try {
    // Attach MAIN_KEYBOARD here so the persistent menu buttons pop up the
    // moment the account finishes linking on the website — the customer
    // never has to come back to the chat and press /start a second time
    // just to make the keyboard appear.
    const sent = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramId, text, reply_markup: cleanButtonLabels(MAIN_KEYBOARD) }),
    });
    if (sent.ok) await kbMarkCurrent(env, telegramId);
  } catch (e) {
    console.error('notify-connected send failed:', e);
  }

  return json({ ok: true }, 200, corsHeaders);
}

// ---------------------------------------------------------------------------
// telegramBotUsers — every telegramId that has ever pressed /start or /menu,
// upserted (chatId/name/lastSeen) so /admin/broadcast below has a full
// audience list. Deliberately NOT the same as "telegramAccounts" (which only
// covers people who went on to link their Linn Game Store account) — a broadcast
// like "Account buying is live now" should reach anyone who's ever opened
// the bot, linked or not.
// ---------------------------------------------------------------------------
// Plain-text (no parse_mode) block appended to the /start welcome so the
// customer can see their own Telegram ID + @username. Plain text on purpose:
// usernames can contain underscores that would break Markdown/HTML parsing.
function telegramIdInfoBlock(lang, from) {
  const id = from && from.id ? String(from.id) : '';
  if (!id) return '';
  const uname = from.username
    ? '@' + from.username
    : (lang === 'en' ? 'Not set' : 'မရှိပါ');
  return `\n\n🆔 Telegram ID: ${id}\n👤 Username: ${uname}`;
}

async function trackBotUser(env, telegramId, chatId, from) {
  try {
    await fsSetDoc(env, `telegramBotUsers/${telegramId}`, {
      chatId: String(chatId),
      firstName: (from && from.first_name) || '',
      username: (from && from.username) || '',
      lastSeen: new Date(),
    });
  } catch (e) {
    console.error('trackBotUser failed:', e);
  }
}

async function listBotUserChatIds(env) {
  const chatIds = [];
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    let pageToken;
    do {
      const qs = new URLSearchParams({ pageSize: '300' });
      if (pageToken) qs.set('pageToken', pageToken);
      const res = await fetch(`${base}/telegramBotUsers?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) break;
      const data = await res.json();
      (data.documents || []).forEach((d) => {
        const chatId = fsField(d.fields, 'chatId') || d.name.split('/').pop();
        if (chatId) chatIds.push({ telegramId: d.name.split('/').pop(), chatId });
      });
      pageToken = data.nextPageToken;
    } while (pageToken);
  } catch (e) {
    console.error('listBotUserChatIds failed:', e);
  }
  return chatIds;
}

// ---------------------------------------------------------------------------
// POST /admin/broadcast — see the header comment for the full contract.
// Validates + kicks the actual send off via ctx.waitUntil so the caller
// (admin.html) doesn't sit there waiting on a few hundred sequential
// Telegram API calls; it just gets an immediate "accepted" back.
// ---------------------------------------------------------------------------
async function handleAdminBroadcast(request, env, ctx, corsHeaders) {
  const configuredSecret = await getAdminBroadcastSecret(env);
  if (!configuredSecret) {
    return json({ error: 'Broadcast not configured' }, 500, corsHeaders);
  }
  const body = await safeJson(request);
  if (!body || typeof body.secret !== 'string' || !timingSafeEqualStr(body.secret, configuredSecret)) {
    return json({ error: 'Unauthorized' }, 401, corsHeaders);
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return json({ error: 'Missing text' }, 400, corsHeaders);
  const imageUrl = cleanNotifImageUrl(body.imageUrl);

  let replyMarkup;
  if (body.buttonText && body.buttonUrl) {
    replyMarkup = { inline_keyboard: [[{ text: String(body.buttonText), web_app: { url: String(body.buttonUrl) } }]] };
  }

  const recipients = await listBotUserChatIds(env);
  const task = broadcastToUsers(env, recipients, text, replyMarkup, imageUrl);
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(task);
  } else {
    // Local/dev fallback with no waitUntil available — just await inline.
    await task;
  }
  return json({ ok: true, accepted: true, recipients: recipients.length }, 200, corsHeaders);
}

// POST /admin/notify-user { secret, telegramId, text, buttonText?, buttonUrl? }
// Admin-triggered free-text DM to ONE customer (event / announcement / warning).
// Same shared secret as /admin/broadcast. For a private chat chat_id === telegramId.
async function handleAdminNotifyUser(request, env, corsHeaders) {
  const configuredSecret = await getAdminBroadcastSecret(env);
  if (!configuredSecret) return json({ error: 'Not configured' }, 500, corsHeaders);
  const body = await safeJson(request);
  if (!body || typeof body.secret !== 'string' || !timingSafeEqualStr(body.secret, configuredSecret)) {
    return json({ error: 'Unauthorized' }, 401, corsHeaders);
  }
  const telegramId = body.telegramId ? String(body.telegramId).trim() : '';
  if (!/^[0-9]{3,20}$/.test(telegramId)) return json({ error: 'Bad telegramId' }, 400, corsHeaders);
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 4000) : '';
  if (!text) return json({ error: 'Missing text' }, 400, corsHeaders);
  let replyMarkup;
  if (body.buttonText && body.buttonUrl) {
    replyMarkup = { inline_keyboard: [[{ text: String(body.buttonText), web_app: { url: String(body.buttonUrl) } }]] };
  }
  const r = await sendBroadcastMessage(env, telegramId, text, replyMarkup, cleanNotifImageUrl(body.imageUrl));
  if (!r.ok) return json({ ok: false, error: r.blocked ? 'User blocked the bot' : 'Telegram send failed' }, 502, corsHeaders);
  return json({ ok: true }, 200, corsHeaders);
}

// Sends `text` (+ optional single inline button) to every recipient, in
// small concurrent batches with a pause between them so this stays well
// under Telegram's ~30 messages/second bot-wide rate limit even for a
// large user list. A 403 back from Telegram means that user has blocked
// the bot (or deleted their account) — those are pruned from
// telegramBotUsers so future broadcasts don't keep paying for them.
async function broadcastToUsers(env, recipients, text, replyMarkup, imageUrl) {
  const BATCH_SIZE = 20;
  const BATCH_DELAY_MS = 1100;
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((r) => sendBroadcastMessage(env, r.chatId, text, replyMarkup, imageUrl))
    );
    for (let j = 0; j < results.length; j++) {
      const res = results[j];
      if (res.status === 'fulfilled' && res.value.ok) {
        sent++;
      } else {
        failed++;
        if (res.status === 'fulfilled' && res.value.blocked) {
          clearBotUser(env, batch[j].telegramId).catch(() => {});
        }
      }
    }
    if (i + BATCH_SIZE < recipients.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }
  console.log(`broadcastToUsers: sent=${sent} failed=${failed} total=${recipients.length}`);
}

// Only plain https image URLs are accepted (Telegram fetches the picture itself); anything else is ignored.
function cleanNotifImageUrl(v) {
  const u = typeof v === 'string' ? v.trim() : '';
  return (/^https:\/\/[^\s]+$/i.test(u) && u.length <= 2000) ? u : '';
}

async function sendBroadcastMessage(env, chatId, text, replyMarkup, imageUrl) {
  try {
    const q = extractQuotes(text);
    if (imageUrl) {
      // Photo first. Caption limit is 1024 chars: short text rides as the caption (one message, button attached);
      // longer text goes as the photo + a normal text message right after it (button on the text message).
      const fitsCaption = q.text.length <= 1024;
      const photo = { chat_id: chatId, photo: imageUrl };
      if (fitsCaption) {
        photo.caption = q.text;
        if (q.entities.length) photo.caption_entities = q.entities;
        if (replyMarkup) photo.reply_markup = replyMarkup;
      }
      const pr = await tgPost(env, 'sendPhoto', photo);
      if (pr.ok) {
        if (fitsCaption) return { ok: true };
        const body2 = { chat_id: chatId, text: q.text };
        if (q.entities.length) body2.entities = q.entities;
        if (replyMarkup) body2.reply_markup = replyMarkup;
        const tr = await tgPost(env, 'sendMessage', body2);
        return tr.ok ? { ok: true } : { ok: true, partial: true };   // the photo reached them
      }
      const pdata = await pr.json().catch(() => ({}));
      if (pdata.error_code === 403) return { ok: false, blocked: true };
      console.error('sendBroadcastMessage: sendPhoto failed, falling back to text only', pdata.description);
      // bad / unreachable image: still deliver the words below
    }
    const payload = { chat_id: chatId, text: q.text };
    if (q.entities.length) payload.entities = q.entities;
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const res = await tgPost(env, 'sendMessage', payload);
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => ({}));
    // error_code 403 = "bot was blocked by the user" / user deactivated.
    return { ok: false, blocked: data.error_code === 403 };
  } catch (e) {
    return { ok: false, blocked: false };
  }
}

async function clearBotUser(env, telegramId) {
  try {
    await fsDeleteDoc(env, `telegramBotUsers/${telegramId}`);
  } catch (e) {
    console.error('clearBotUser failed:', e);
  }
}

// ---------------------------------------------------------------------------
// POST /notify-order-status — admin.html calls this right after an order's
// status changes (Pending -> Processing -> Success/Fail), so the customer
// gets a DM through linngamestorebot instead of only finding out next time
// they reopen the Store app.
//
// { secret, telegramId, orderId, status, game?, price?, note? } — `secret`
// must match ADMIN_BROADCAST_SECRET (same shared secret /admin/broadcast
// uses; this is just another admin-triggered push, to one person instead of
// everyone). `telegramId` is the value written to users/{uid}.telegramId
// when that customer linked Telegram — for a one-on-one Telegram chat,
// chat_id === that same id, so no telegramBotUsers lookup is needed here
// (unlike /admin/broadcast, which needs a chatId per recipient).
// ---------------------------------------------------------------------------
async function handleOrderStatusNotify(request, env, corsHeaders) {
  const configuredSecret = await getAdminBroadcastSecret(env);
  if (!configuredSecret) {
    return json({ error: 'Not configured' }, 500, corsHeaders);
  }
  const body = await safeJson(request);
  if (!body || typeof body.secret !== 'string' || !timingSafeEqualStr(body.secret, configuredSecret)) {
    return json({ error: 'Unauthorized' }, 401, corsHeaders);
  }
  const telegramId = body.telegramId ? String(body.telegramId) : '';
  const status = typeof body.status === 'string' ? body.status.trim() : '';
  if (!telegramId || !status) {
    return json({ error: 'Missing telegramId or status' }, 400, corsHeaders);
  }
  const orderId = body.orderId ? String(body.orderId) : '';
  const game = body.game ? String(body.game) : '';
  const price = Number(body.price || 0);
  const note = body.note ? String(body.note) : '';
  // Only populated on the Success/confirm push (see notifyOrderStatusChange
  // in admin.html) — used to attach the full order-details block below.
  // Deliberately no receipt/photo field here: unlike the order-created
  // flow, the confirm DM is text-only.
  const details = {
    userName: body.userName ? String(body.userName) : '',
    userId: body.userId ? String(body.userId) : '',
    inGameId: body.inGameId ? String(body.inGameId) : '',
    serverId: body.serverId ? String(body.serverId) : '',
    packageName: body.packageName ? String(body.packageName) : '',
  };

  let text = orderStatusMessageText(status, orderId, game, price, note, details);
  // On a finished order, show what's left in the wallet (read fresh from
  // Firestore here, so it works for every caller - admin.html and the
  // admin bot - without either having to pass a balance in).
  const normStatus = status.toLowerCase();
  if (normStatus === 'success' || normStatus === 'completed' || normStatus === 'delivered') {
    const bal = await getWalletBalanceByTelegramId(env, telegramId);
    if (bal !== null) text += `\n\n💰 လက်ကျန်ငွေ: ${bal.toLocaleString()} MMK`;
  }
  let balance = null;
  if (normStatus === 'success' || normStatus === 'completed' || normStatus === 'delivered') {
    const m = /လက်ကျန်ငွေ: ([\d,]+) MMK/.exec(text);
    if (m) balance = Number(m[1].replace(/,/g, ''));
  }
  let rich = null;
  try { rich = buildOrderStatusRichBlocks(status, orderId, game, price, note, details, balance); }
  catch (e) { console.error('order rich blocks failed', e); }
  await deliverOrderStatusMessage(env, telegramId, orderId, status, text, openAppInlineKeyboard(), rich);
  await maybeSendLowBalanceAlert(env, telegramId);
  return json({ ok: true }, 200, corsHeaders);
}

// ---------------------------------------------------------------------------
// Live order status — one message per order instead of one per status change.
//
//  Pending / Processing : the first push sends a message and remembers its
//                         message_id (Firestore "telegramOrderMsgs/{orderId}");
//                         later pushes EDIT that same message, so the chat
//                         shows one card whose progress line moves forward.
//                         (Telegram does not buzz the phone for an edit.)
//  Success / Fail       : the old live card is deleted and a fresh message is
//                         sent, so the customer is notified once, with the
//                         final result, and the chat keeps a single message
//                         for that order.
//
// Falls back to sending a normal new message whenever the edit can't happen
// (message deleted by the customer, too old, Firestore hiccup), so a status
// update is never lost. A repeated push of the same in-progress status is
// ignored (admin double-click) instead of erroring.
// ---------------------------------------------------------------------------
function isFinalOrderStatus(status) {
  const n = String(status || '').trim().toLowerCase();
  return ['success', 'completed', 'delivered', 'fail', 'failed', 'rejected'].includes(n);
}

async function readOrderLiveMsg(env, orderId) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const res = await fetch(`${base}/telegramOrderMsgs/${encodeURIComponent(orderId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const doc = await res.json();
    if (!doc.fields) return null;
    const messageId = Number(fsField(doc.fields, 'messageId'));
    const chatId = fsField(doc.fields, 'chatId');
    if (!messageId || !chatId) return null;
    return { messageId, chatId: String(chatId), status: String(fsField(doc.fields, 'status') || '') };
  } catch (e) {
    console.error('readOrderLiveMsg failed:', e);
    return null;
  }
}

// ---- Order card as a bordered table (Telegram rich message), classic text as the fallback --------------
const orCell = (t, header) => ({ text: String(t), align: 'left', valign: 'middle', ...(header ? { is_header: true } : {}) });
const orPara = (t, bold) => ({ type: 'paragraph', text: bold ? { type: 'bold', text: String(t) } : String(t) });

function buildOrderStatusRichBlocks(status, orderId, game, price, note, details, balance) {
  const d = details || {};
  const norm = String(status || '').trim().toLowerCase();
  const ok = ['success', 'completed', 'delivered'].includes(norm);
  const bad = ['fail', 'failed', 'rejected'].includes(norm);
  const title = ok ? '✅ Order ပြီးပါပြီ!' : bad ? '❌ Order မအောင်မြင်ပါ'
    : norm === 'processing' ? '⏳ Order ကို လုပ်ဆောင်နေပါပြီ'
    : norm === 'pending' ? '🕐 Order လက်ခံပြီးပါပြီ' : `🔔 Order Update`;
  // compact: 5 short rows (game + package together, player + server together)
  const rows = [['🧾 Order', `#${orderId || '-'}`]];
  if (game || d.packageName) rows.push(['🎮 Game', [game, d.packageName].filter(Boolean).join(' · ')]);
  if (d.inGameId) rows.push(['🆔 ID', d.serverId ? `${d.inGameId} (${d.serverId})` : String(d.inGameId)]);
  if (price > 0) rows.push(['💰 ဈေး', `${price.toLocaleString()} MMK`]);
  rows.push(['📌 Status', orderStatusBadge(status)]);
  const blocks = [
    orPara(title, true),
    { type: 'table', is_bordered: true, is_compact: true, cells: [[orCell('Order', true), orCell('အသေးစိတ်', true)], ...rows.map(r => [orCell(r[0]), orCell(r[1])])] },
  ];
  const tl = orderTimelineLine(status);
  if (tl && !ok) blocks.push(orPara(tl));
  if (ok) blocks.push(orPara('Game ထဲ ဝင်စစ်ကြည့်ပါ (ပိတ်ပြီး ပြန်ဖွင့်ရတတ်ပါတယ်)။'));
  else if (bad) blocks.push(orPara('ငွေကို Wallet ထဲ ပြန်ထည့်ပေးပါတယ်။ ID / Server ပြန်စစ်ပြီး Order အသစ်တင်ပါ။'));
  else if (norm === 'processing') blocks.push(orPara('ပြီးတာနဲ့ အကြောင်းကြားပါမယ်။ ထပ်မတင်ပါနဲ့။'));
  else if (norm === 'pending') blocks.push(orPara('မကြာခင် လုပ်ဆောင်ပါမယ်။ ဒီ Card ကိုယ်တိုင် ပြောင်းပါမယ်။'));
  if (note) blocks.push(orPara('📝 Admin မှတ်ချက်', true), orPara(note));
  if (balance !== null && balance !== undefined && !Number.isNaN(balance)) blocks.push(orPara(`💰 လက်ကျန်ငွေ: ${balance.toLocaleString()} MMK`));
  const kb = openAppInlineKeyboard();
  for (const row of kb.inline_keyboard) blocks.push({ type: 'buttons', align: 'center', buttons: row.slice(0, 8).map(b => { const { icon_custom_emoji_id, ...rest } = b || {}; return rest; }) });
  return blocks;
}

// Rich send / edit. Return the message id (send) / true (edit), or null so the caller falls back to plain text.
async function sendOrderRich(env, chatId, blocks) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendRichMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, rich_message: { blocks } }),
    });
    const data = await r.json().catch(() => null);
    if (r.ok && data && data.ok && data.result) return data.result.message_id || null;
    console.error('order rich send failed, classic fallback', data && data.description);
  } catch (e) { console.error('order rich send error', e); }
  return null;
}
async function editOrderRich(env, chatId, messageId, blocks) {
  try {
    await spinGuard('editMessageText', { chat_id: chatId, message_id: messageId });
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, rich_message: { blocks } }),
    });
    const data = await r.json().catch(() => null);
    if (r.ok && data && data.ok) return true;
    if (data && /not modified/i.test(String(data.description || ''))) return true;
    console.error('order rich edit failed, classic fallback', data && data.description);
  } catch (e) { console.error('order rich edit error', e); }
  return false;
}

async function deliverOrderStatusMessage(env, telegramId, orderId, status, text, replyMarkup, richBlocks) {
  const norm = String(status || '').trim().toLowerCase();
  const final = isFinalOrderStatus(status);
  const sendCard = async () => {
    if (richBlocks) { const id = await sendOrderRich(env, telegramId, richBlocks); if (id) return id; }
    return sendTelegramMessage(env, telegramId, text, replyMarkup);
  };
  const editCard = async (chatId, messageId) => {
    if (richBlocks && await editOrderRich(env, chatId, messageId, richBlocks)) return true;
    return editTelegramMessage(env, chatId, messageId, text, replyMarkup);
  };
  if (!orderId) return sendCard();

  const live = await readOrderLiveMsg(env, orderId);

  if (live && !final) {
    if (live.status === norm) return; // same status pushed twice — nothing to update
    const edited = await editCard(live.chatId, live.messageId);
    if (edited) {
      await fsMergeDoc(env, `telegramOrderMsgs/${encodeURIComponent(orderId)}`, { status: norm, updatedAt: new Date() }).catch(() => {});
      return;
    }
    // Edit failed — fall through and send a fresh card.
  }

  if (live && final) {
    await tgPost(env, 'deleteMessage', { chat_id: live.chatId, message_id: live.messageId }).catch(() => {});
    await fsDeleteDoc(env, `telegramOrderMsgs/${encodeURIComponent(orderId)}`).catch(() => {});
  }

  const messageId = await sendCard();
  if (!final && messageId) {
    await fsSetDoc(env, `telegramOrderMsgs/${encodeURIComponent(orderId)}`, {
      chatId: String(telegramId),
      messageId: Number(messageId),
      status: norm,
      updatedAt: new Date(),
    }).catch((e) => console.error('save live order msg failed:', e));
  }
}

// Current wallet balance (MMK) for a Telegram-linked customer, or null when
// the account can't be found - callers just skip the balance line then.
async function getWalletBalanceByTelegramId(env, telegramId) {
  const acct = await lookupAccountByTelegramId(env, telegramId);
  return acct ? Number(acct.walletBalance || 0) : null;
}

// Wallet-topup result DM — called by telegram-worker.js (the admin bot,
// @linnwebhelper_bot) right after a human taps Confirm & Credit / Reject on
// a walletTopups doc, so the customer who submitted the top-up *inside this
// bot's own chat* (see submitTopupReceipt() below, which now stamps
// telegramId onto the doc) actually hears back here instead of only seeing
// the admin's own message get edited on the admin side. Mirrors
// handleOrderStatusNotify's auth pattern (same settings/adminBroadcast
// secret) but with topup-shaped wording instead of order-shaped wording.
// ---- Top-up DM de-duplication -------------------------------------------------------------------
// Two callers can announce the same result (admin.html's Confirm/Reject AND the admin bot's in-chat buttons), so
// the customer used to be able to get the same DM twice. Every push claims a marker doc first; a second push for
// the same event is acknowledged but NOT sent.
//   * shared key  telegramId + status + amount : any caller, repeats within 2 minutes are skipped
//   * topupId key (when the caller sends topupId): that exact top-up + status is only ever announced once
// Fails OPEN: if Firestore can't be reached the DM is sent anyway (a duplicate beats a lost message).
async function fsClaimMarker(env, docId, data) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const res = await fetch(`${base}/telegramTopupNotified?documentId=${encodeURIComponent(docId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fields: toFsFields(data) }),
    });
    if (res.status === 409) return 'exists';
    return res.ok ? 'created' : 'error';
  } catch (e) { return 'error'; }
}
async function topupNotifyClaim(env, telegramId, status, amount, topupId) {
  const clean = (x) => String(x).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
  const norm = String(status || '').toLowerCase();
  const now = Date.now();
  const keys = [];
  const nk = clean(`n_${telegramId}_${norm}_${Math.round(Number(amount) || 0)}`);
  let r = await fsClaimMarker(env, nk, { sentAtMs: now });
  if (r === 'exists') {
    const f = await fsGetFields(env, `telegramTopupNotified/${nk}`).catch(() => null);
    const at = f ? Number(fsField(f, 'sentAtMs') || 0) : 0;
    if (now - at < 2 * 60 * 1000) return { dup: true, keys };
    await fsMergeDoc(env, `telegramTopupNotified/${nk}`, { sentAtMs: now }).catch(() => {});   // old event, same wording: allow
  }
  keys.push(nk);
  if (topupId) {
    const ik = clean(`t_${topupId}_${norm}`);
    r = await fsClaimMarker(env, ik, { sentAtMs: now });
    if (r === 'exists') return { dup: true, keys };
    keys.push(ik);
  }
  return { dup: false, keys };
}
async function topupNotifyRelease(env, keys) {
  for (const k of keys || []) await fsDeleteDoc(env, `telegramTopupNotified/${k}`).catch(() => {});
}

async function handleTopupStatusNotify(request, env, corsHeaders) {
  const configuredSecret = await getAdminBroadcastSecret(env);
  if (!configuredSecret) {
    console.error('notify-topup-status: no admin broadcast secret configured');
    return json({ error: 'Not configured' }, 500, corsHeaders);
  }
  const body = await safeJson(request);
  if (!body || typeof body.secret !== 'string' || !timingSafeEqualStr(body.secret, configuredSecret)) {
    console.error('notify-topup-status: unauthorized (secret missing or does not match)');
    return json({ error: 'Unauthorized' }, 401, corsHeaders);
  }
  const telegramId = body.telegramId ? String(body.telegramId) : '';
  const status = typeof body.status === 'string' ? body.status.trim() : '';
  if (!telegramId || !status) {
    console.error('notify-topup-status: missing telegramId/status, got keys:', Object.keys(body).join(','));
    return json({ error: 'Missing telegramId or status' }, 400, corsHeaders);
  }
  const amount = Number(body.amount || 0);
  const topupId = body.topupId ? String(body.topupId) : '';
  console.log('notify-topup-status:', JSON.stringify({ telegramId, status, amount, topupId }));
  const claim = await topupNotifyClaim(env, telegramId, status, amount, topupId);
  if (claim.dup) {
    console.log('notify-topup-status: duplicate skipped', telegramId, status, amount, topupId);
    return json({ ok: true, deduped: true }, 200, corsHeaders);
  }
  let text = topupStatusMessageText(status, amount);
  let topupBalance = null;
  if (status.toLowerCase() === 'completed') {
    // The wallet was credited just before this call, so this is the
    // balance *after* the top-up.
    const bal = await getWalletBalanceByTelegramId(env, telegramId);
    topupBalance = bal;
    if (bal !== null) text += `\n\n💰 Available Balance: ${bal.toLocaleString()} MMK`;
  }
  // Rejected top-up: button goes to the owner's Telegram chat (not the app).
  const replyMarkup = status.toLowerCase() === 'rejected'
    ? { inline_keyboard: [[{ text: '💬 Owner ကို ဆက်သွယ်ရန်', url: 'https://t.me/linn270_0' }]] }
    : openAppInlineKeyboard();
  const normTopup = status.toLowerCase();
  const topupRows = [];
  if (amount > 0) topupRows.push(['💰 Amount', `${amount.toLocaleString()} MMK`]);
  topupRows.push(['📌 Status', normTopup === 'completed' ? '✅ Completed' : normTopup === 'rejected' ? '❌ Rejected' : status]);
  if (topupBalance !== null) topupRows.push(['💼 လက်ကျန်ငွေ', `${topupBalance.toLocaleString()} MMK`]);
  const topupBlocks = richTableBlocks(
    normTopup === 'completed' ? '✅ Wallet Top Up အောင်မြင်ပါပြီ!' : normTopup === 'rejected' ? '❌ Wallet Top Up ငြင်းပယ်ခံရပါသည်' : '🔔 Wallet Top Up Update',
    topupRows
  );
  topupBlocks.push(orPara(normTopup === 'completed'
    ? 'Wallet ထဲသို့ ပေါင်းထည့်ပြီးပါပြီ။ ကျေးဇူးတင်ပါတယ်! 🙏'
    : normTopup === 'rejected'
      ? 'သင့် Receipt ကို အတည်ပြုမရနိုင်ပါ။ အသေးစိတ် သိရှိလိုပါက Owner ကို ဆက်သွယ်ပါ။'
      : 'အခြေအနေ ပြောင်းလဲမှု ရှိပါသည်။'));
  let finalMarkup = replyMarkup;
  if (normTopup === 'completed' && await buyReadResume(env, telegramId)) {
    finalMarkup = { inline_keyboard: [[styled({ text: 'ဝယ်ယူမှု ဆက်လုပ်မည်', callback_data: 'bg:rs' }, 'success')], ...replyMarkup.inline_keyboard] };
  }
  const sentId = await sendRichCard(env, telegramId, topupBlocks, text, finalMarkup);
  if (!sentId) {
    await topupNotifyRelease(env, claim.keys);   // nothing was delivered, so a retry must be allowed through
    // Report the failure to the caller (telegram-worker.js) instead of a
    // false { ok: true } — the reason is in this Worker's logs.
    return json({ ok: false, error: 'Telegram send failed' }, 502, corsHeaders);
  }
  if (status.toLowerCase() === 'completed') {
    await maybeSendLowBalanceAlert(env, telegramId);
  }
  return json({ ok: true }, 200, corsHeaders);
}

// Warning DM when the admin panel zeroes a wallet that had no top-up / order history.
// { secret, telegramId, amount } - same shared admin secret as the other notify endpoints.
async function handleWalletWarningNotify(request, env, corsHeaders) {
  const configuredSecret = await getAdminBroadcastSecret(env);
  if (!configuredSecret) return json({ error: 'Not configured' }, 500, corsHeaders);
  const body = await safeJson(request);
  if (!body || typeof body.secret !== 'string' || !timingSafeEqualStr(body.secret, configuredSecret)) return json({ error: 'Unauthorized' }, 401, corsHeaders);
  const telegramId = body.telegramId ? String(body.telegramId) : '';
  if (!telegramId) return json({ error: 'Missing telegramId' }, 400, corsHeaders);
  const amount = Number(body.amount || 0);
  const text = `\u26a0\ufe0f Wallet Warning\n\n\u101e\u1004\u1037\u103a Wallet \u1011\u1032\u1000 ${amount.toLocaleString()} MMK \u1000\u102d\u102f Top Up / Order \u1019\u103e\u1010\u103a\u1010\u1019\u103a\u1038\u1019\u101b\u103e\u102d\u101e\u1031\u102c\u1000\u103c\u1031\u102c\u1004\u1037\u103a \u1015\u101a\u103a\u1001\u103b\u101c\u102d\u102f\u1000\u103a\u1015\u102b\u101e\u100a\u103a\u104b \u1019\u103e\u102c\u1038\u101a\u103d\u1004\u103a\u1038\u1019\u103e\u102f\u101f\u102f\u101a\u1030\u1006\u1015\u102b\u1000 Help Center \u101e\u102d\u102f\u1037 \u1006\u1000\u103a\u101e\u103d\u101a\u103a\u1015\u102b\u104b`;
  const sentId = await sendTelegramMessage(env, telegramId, text, { inline_keyboard: [[{ text: '\ud83d\udcac Owner \u1000\u102d\u102f \u1006\u1000\u103a\u101e\u103d\u101a\u103a\u101b\u1014\u103a', url: 'https://t.me/linn270_0' }]] });
  if (!sentId) return json({ ok: false, error: 'Telegram send failed' }, 502, corsHeaders);
  return json({ ok: true }, 200, corsHeaders);
}

function topupStatusMessageText(status, amount) {
  const amountLine = amount > 0 ? `${amount.toLocaleString()} MMK` : '';
  const norm = (status || '').toLowerCase();
  if (norm === 'completed') {
    return `✅ Wallet Top Up အောင်မြင်ပါပြီ!\n\n${amountLine} ကို Wallet ထဲသို့ ပေါင်းထည့်ပြီးပါပြီ။ ကျေးဇူးတင်ပါတယ်!`;
  }
  if (norm === 'rejected') {
    return `❌ Wallet Top Up ငြင်းပယ်ခံရပါသည်\n\n${amountLine} အတွက် သင့် Receipt ကို အတည်ပြုမရနိုင်ပါ။ အသေးစိတ် သိရှိလိုပါက Help Center သို့ ဆက်သွယ်ပါ။`;
  }
  return `🔔 Wallet Top Up Update\n\nအခြေအနေ: ${status}`;
}

const LOW_BALANCE_THRESHOLD = 5000; // MMK — matches WALLET_TOPUP_MIN, the smallest top-up worth making

// Best-effort nudge: right after an order-status push (the point a purchase
// most recently touched this customer's balance), checks their current
// wallet balance and, if it's run low, sends a separate "top up before your
// next order fails" DM. NOT a realtime wallet watcher — this Worker has no
// other hook into wallet writes (those happen in admin.html/store.html,
// outside this file) — so a balance drop with no order attached (e.g. a
// manual admin adjustment) won't trigger this. Fires on every low-balance
// order-status push with no de-dupe/cooldown yet; add a "lastWarnedAt" flag
// on the user doc later if repeat alerts across several small orders in a
// row turn out to be too chatty.
async function maybeSendLowBalanceAlert(env, telegramId) {
  try {
    const acct = await lookupAccountByTelegramId(env, telegramId);
    if (!acct) return;
    const balance = Number(acct.walletBalance || 0);
    if (balance > 0 && balance < LOW_BALANCE_THRESHOLD) {
      await sendTelegramMessage(
        env, telegramId,
        `⚠️ Wallet ထဲမှာ ${balance.toLocaleString()} MMK ပဲ ကျန်တော့တယ်။\n\nနောက်ဝယ်တဲ့အခါ ငွေမလောက်မှာ စိုးရင် ကြိုဖြည့်ထားလိုက်ပါ။`,
        { inline_keyboard: [[{ text: '➕ Top Up Wallet', url: STORE_URL }]] }
      );
    }
  } catch (e) {
    console.error('maybeSendLowBalanceAlert failed:', e);
  }
}

// Friendly Burmese wording per order status. admin.html's "orders" collection
// only ever uses Pending/Processing/Success/Fail, but this also recognizes a
// few synonyms (Completed/Delivered/Rejected) in case that ever changes, and
// falls back to a generic "status changed to X" line for anything else -
// so a new status added in admin.html doesn't also need a matching Worker
// deploy just to keep notifying.
// Small text-based progress track for an order's status — Telegram has no
// real progress-bar widget, so a "🟢 Pending → 🟡 Processing → ⚪ Success"
// line stands in for one. Recognizes the same status set + synonyms as
// orderStatusMessageText below, and degrades to just the raw status text for
// anything unrecognized instead of guessing.
function orderTimelineLine(status) {
  const stages = ['Pending', 'Processing', 'Success'];
  const norm = (status || '').trim().toLowerCase();
  if (norm === 'fail' || norm === 'failed' || norm === 'rejected') {
    return '🟢 Pending → 🟢 Processing → ❌ Fail';
  }
  const idx = stages.findIndex((s) => s.toLowerCase() === norm);
  if (idx === -1) return status ? `🔔 ${status}` : '';
  return stages.map((s, i) => `${i < idx ? '🟢' : i === idx ? '🟡' : '⚪'} ${s}`).join(' → ');
}

function formatOrderDate(ts) {
  if (!(ts instanceof Date) || isNaN(ts.getTime())) return '';
  // en-GB gives DD/MM/YYYY, HH:MM — reads unambiguously either way round for
  // a Myanmar audience, unlike MM/DD/YYYY.
  return ts.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Short "✅ Success" / "❌ Fail" / "⏳ Processing" / "🕐 Pending" badge shown
// at the top of the confirm-DM details block. Falls back to the raw status
// text for anything unrecognized (same synonym set as orderTimelineLine).
function orderStatusBadge(status) {
  const norm = (status || '').trim().toLowerCase();
  if (norm === 'success' || norm === 'completed' || norm === 'delivered') return '✅ Success';
  if (norm === 'fail' || norm === 'failed' || norm === 'rejected') return '❌ Fail';
  if (norm === 'processing') return '⏳ Processing';
  if (norm === 'pending') return '🕐 Pending';
  return status ? `🔔 ${status}` : '';
}

// Full order-details block — User / User ID / In Game ID / Server ID
// (only when the order actually has one, e.g. Mobile Legends) / Package /
// Amount / Order ID, topped with the status badge. Only ever attached to
// the Success/confirm push (see orderStatusMessageText below); Pending/
// Processing/Fail keep the older short one-liner. No receipt/photo here —
// that only ever goes out at order-creation time, not on this DM.
function buildOrderConfirmDetailsBlock(status, orderId, game, price, details) {
  const d = details || {};
  const packageLine = d.packageName || game
    ? `📦 Package: ${[d.packageName, game].filter(Boolean).join(' — ')}`
    : null;
  const lines = [
    `Order Status: ${orderStatusBadge(status)}`,
    '',
    d.userName ? `👤 User: ${d.userName}` : null,
    d.userId ? `🆔 User ID: ${d.userId}` : null,
    d.inGameId ? `🎮 In Game ID: ${d.inGameId}` : null,
    d.serverId ? `🌐 Server ID: ${d.serverId}` : null,
    packageLine,
    price > 0 ? `💰 Amount: ${price.toLocaleString()} MMK` : null,
    `🧾 Order ID: #${orderId || '-'}`,
  ].filter((l) => l !== null);
  return lines.join('\n');
}

function orderStatusMessageText(status, orderId, game, price, note, details) {
  const orderLine = `🧾 Order ID: #${orderId || '-'}${game ? `\n🎮 Game: ${game}` : ''}`;
  const priceLine = price > 0 ? `\n💰 ဈေးနှုန်း: ${price.toLocaleString()} MMK` : '';
  const noteLine = note ? `\n\n📝 Admin မှတ်ချက်:\n${note}` : '';
  const timeline = orderTimelineLine(status);
  const timelineLine = timeline ? `\n\n${timeline}` : '';
  const norm = (status || '').trim().toLowerCase();

  if (norm === 'success' || norm === 'completed' || norm === 'delivered') {
    // The details block already carries the ✅ status badge, so no timeline
    // line here (it would just say the same thing twice).
    const detailsBlock = buildOrderConfirmDetailsBlock(status, orderId, game, price, details);
    return [
      '✅ Order ပြီးပါပြီ!',
      '',
      detailsBlock,
      '',
      'Game ထဲဝင်ပြီး စစ်ကြည့်လိုက်ပါ။ တစ်ခါတလေ Game ကို ပိတ်ပြီး ပြန်ဖွင့်မှ ပေါ်တတ်ပါတယ်။',
      '',
      quoteBlock('မိနစ် ၁၅ လောက်ကြာတာတောင် မရောက်သေးရင် 💬 Help Center ကနေ Order ID နဲ့ ပြောပါ။'),
      '',
      'အားပေးတဲ့အတွက် ကျေးဇူးတင်ပါတယ် 🙏',
    ].join('\n') + noteLine;
  }

  if (norm === 'fail' || norm === 'failed' || norm === 'rejected') {
    return [
      '❌ Order မအောင်မြင်ပါ',
      '',
      orderLine + priceLine,
      '',
      'စိတ်မကောင်းပါဘူး၊ ဒီ Order ကို မပြီးစီးနိုင်ခဲ့ပါဘူး။ ဖြတ်ထားတဲ့ ငွေကို Wallet ထဲ ပြန်ထည့်ပေးပါတယ်။',
      '',
      'အများဆုံး ဖြစ်တတ်တာက Game ID (သို့) Server ID မှားနေတာပါ။ အောက်မှာ Admin မှတ်ချက် ရှိရင် အရင်ဖတ်ပါ၊ ပြီးရင် ID ကို ပြန်စစ်ပြီး Order အသစ် တင်ကြည့်ပါ။',
      '',
      quoteBlock('ငွေပြန်မဝင်ရင် (သို့) အကြောင်းရင်း မရှင်းရင် 💬 Help Center ကနေ Order ID နဲ့ ပြောပါ။'),
    ].join('\n') + timelineLine + noteLine;
  }

  if (norm === 'processing') {
    return [
      '⏳ Order ကို လုပ်ဆောင်နေပါပြီ',
      '',
      orderLine + priceLine,
      '',
      'ပုံမှန်ဆို မိနစ် ၅ မှ ၃၀ အတွင်း ပြီးပါတယ်။ ပြီးတာနဲ့ Bot က အကြောင်းကြားပါမယ်။',
      '',
      quoteBlock('ဒီ Order ကို ထပ်မတင်ပါနဲ့၊ ငွေနှစ်ခါ ကျသွားနိုင်ပါတယ်။'),
    ].join('\n') + timelineLine + noteLine;
  }

  if (norm === 'pending') {
    return [
      '🕐 Order လက်ခံပြီးပါပြီ',
      '',
      orderLine + priceLine,
      '',
      'Admin က မကြာခင် စလုပ်ပေးပါမယ်။ ဘာမှ ထပ်လုပ်စရာ မလိုပါဘူး။',
    ].join('\n') + timelineLine + noteLine;
  }

  return [
    '🔔 Order Update',
    '',
    orderLine + priceLine,
    '',
    `အခြေအနေ: ${status}`,
  ].join('\n') + timelineLine + noteLine;
}


async function mintFirebaseToken(env, tgUser) {
  const uid = `tg_${tgUser.id}`;
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    sub: env.FIREBASE_CLIENT_EMAIL,
    aud: FIREBASE_AUD,
    iat: now,
    exp: now + 3600,
    uid,
    claims: {
      telegram_id: tgUser.id,
      telegram_username: tgUser.username || null,
    },
  };

  const encHeader = base64url(JSON.stringify(header));
  const encPayload = base64url(JSON.stringify(payload));
  const unsigned = `${encHeader}.${encPayload}`;

  const key = await importPrivateKey(env.FIREBASE_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    strToBuf(unsigned)
  );

  return `${unsigned}.${base64urlFromBuf(signature)}`;
}

async function importPrivateKey(pem) {
  const normalized = pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
  const pemBody = normalized
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const binary = atob(pemBody);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return crypto.subtle.importKey(
    'pkcs8',
    bytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

// ---------------------------------------------------------------------------
// Crypto / encoding helpers
// ---------------------------------------------------------------------------
function strToBuf(str) {
  return new TextEncoder().encode(str);
}

async function sha256Raw(buf) {
  return crypto.subtle.digest('SHA-256', buf);
}

async function hmacSha256Raw(keyBuf, msgBuf) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBuf,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', key, msgBuf);
}

async function hmacSha256Hex(keyBuf, msgBuf) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBuf,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, msgBuf);
  return bufToHex(sig);
}

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Same constant-time comparison, but for arbitrary strings (e.g. the
// Telegram webhook secret token) rather than hex digests specifically.
function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function buildDataCheckString(params) {
  const keys = [...params.keys()].sort();
  return keys.map((k) => `${k}=${params.get(k)}`).join('\n');
}

function base64url(str) {
  return base64urlFromBuf(strToBuf(str).buffer);
}

function base64urlFromBuf(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function buildCorsHeaders(origin, env) {
  // Storefront origins are fixed above. The admin panel is served from a DIFFERENT origin and calls
  // /admin/broadcast, /admin/notify-user, /notify-order-status and /notify-wallet-warning straight from the browser,
  // so set the Worker variable ADMIN_ORIGINS (comma list), e.g.
  //   https://admin.linngamestore.com,https://your-admin.vercel.app
  // Only while ADMIN_ORIGINS is NOT set, the old Vercel admin panel stays allowed so notifications keep working.
  const DEFAULT_ADMIN_ORIGINS = ['https://linnmangepanelssc.vercel.app'];
  const extra = String((env && env.ADMIN_ORIGINS) || '').split(',').map((x) => x.trim()).filter(Boolean);
  const allowed = ALLOWED_ORIGINS.concat(extra.length ? extra : DEFAULT_ADMIN_ORIGINS);
  const headers = {
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
  if (allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;   // any other origin: no CORS header, the browser blocks it
  return headers;
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers });
}

// ===========================================================================
// IN-BOT BUY FLOW  ("Game List" reply-keyboard button, callback prefix "bg:")
//
// Game List -> Direct Top Up / Voucher and Gift Card / Software
//  -> games (5 rows x 2 columns per page, store order; "Name (N)" = N servers)
//  -> server picker (multi-server games only) -> catalog card (type tabs, in-message buttons)
//  -> the PRICE LIST is a separate numbered text message; the customer TYPES the package number
//  -> no account yet: "Create account" button opens one inside the bot (botRegisterAccount), no store login
//  ⛔ Stop (every card) wipes the whole flow and starts over from Game List.
//  -> (quantity typed for vouchers) ID (+Server ID, any separator) -> Name Check
//  -> Wallet or Payment -> (Wallet: confirm | not enough: top up / Payment)
//  -> (Payment: pick method -> transfer -> receipt photo -> Confirm)
//  -> order created -> Order Status card.
//
// Orders are NOT written to Firestore here. They are sent to the order Worker's
// POST /orders/create exactly like the website does (Firebase ID token for
// uid "tg_<id>", sealed envelope), so price / owner / ban / receipt / security
// checks stay authoritative in one place.
//
// REQUIRED: a Service Binding on THIS worker:  ORDER_WORKER -> linnmanagebot
// (a plain workers.dev fetch between two Workers of one account can fail with
// error 1042, see the ImgBB comment above). Optional env: ORDER_WORKER_URL.
// ===========================================================================
const BUY_SOFTWARE_ADMIN = 'linn270_0';
const BUY_GAMES_PER_PAGE = 10;   // 5 rows x 2 columns
const BUY_SERVERS_PER_PAGE = 10;
const BUY_PKGS_PER_PAGE = 8;
const BUY_QTY_CHOICES = [1, 2, 3, 5, 10];
const BUY_CAT_LABEL = { d: 'Direct Top Up', v: 'Voucher and Gift Card', s: 'Software' };
const BUY_FAZER_VALIDATE_URL = 'https://fazercards-provider.linngamestore.workers.dev/fazercard-validate';
const bt = (lang, my, en) => (lang === 'en' ? en : my);
const mmk = (n) => `${Number(n || 0).toLocaleString()} MMK`;

function fsDecode(v) {
  if (!v || typeof v !== 'object') return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fsDecode);
  if ('mapValue' in v) { const o = {}; const f = v.mapValue.fields || {}; for (const k in f) o[k] = fsDecode(f[k]); return o; }
  return undefined;
}
function fsDecodeDoc(d) {
  const o = { id: String(d.name || '').split('/').pop() };
  const f = d.fields || {};
  for (const k in f) o[k] = fsDecode(f[k]);
  return o;
}
function fsBase(env) { return `https://firestore.googleapis.com/v1/projects/${firestoreProjectId(env)}/databases/(default)/documents`; }

// ---- data -----------------------------------------------------------------
const BUY_LIST_FIELDS = ['name', 'serverName', 'order', 'createdAt', 'fulfillProvider', 'category', 'g2bulkVoucherCategory', 'fazercardGiftCategoryId', 'packages'];
let _buyGamesCache = { at: 0, games: null };
async function buyListGames(env) {
  if (_buyGamesCache.games && Date.now() - _buyGamesCache.at < 30000) return _buyGamesCache.games;
  const token = await getFirestoreAccessToken(env);
  const mask = BUY_LIST_FIELDS.map((f) => `mask.fieldPaths=${f}`).join('&');
  const games = [];
  let pageToken = '';
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${fsBase(env)}/games?pageSize=300&${mask}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`games list HTTP ${res.status}`);
    const data = await res.json();
    for (const d of data.documents || []) {
      const g = fsDecodeDoc(d);
      // store.html isVoucherGame(): a game carrying voucher packages is a voucher even without fulfillProvider
      g.vp = Array.isArray(g.packages) && g.packages.some((p) => p && (p.voucherId || p.fazercardGiftCardId));
      delete g.packages;   // keep the cache small; the price list re-reads the full game doc
      games.push(g);
    }
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }
  _buyGamesCache = { at: Date.now(), games };
  return games;
}
async function buyGetGame(env, gid) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(gid || ''))) return null;
  const token = await getFirestoreAccessToken(env);
  const res = await fetch(`${fsBase(env)}/games/${gid}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return fsDecodeDoc(await res.json());
}
async function buyProviderFlags(env) {
  const out = {};
  try {
    const token = await getFirestoreAccessToken(env);
    const res = await fetch(`${fsBase(env)}/settings/providerFlags`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return out;
    const doc = await res.json();
    const f = doc.fields || {};
    ['g2bulk', 'fazercard', 'jcplays'].forEach((p) => {
      out[p] = { off: fsDecode(f[p]) === false, soon: fsDecode(f[`${p}ComingSoon`]) === true };
    });
  } catch (e) { console.error('buyProviderFlags failed:', e); }
  return out;
}
function buyCatOf(g) {
  const fp = g.fulfillProvider || '';
  if (fp === 'software') return 's';
  if (fp === 'g2bulk_voucher' || fp === 'fazercard_giftcard' || fp === 'jcplays' || fp === 'voucher_manual' || g.g2bulkVoucherCategory || g.fazercardGiftCategoryId || g.vp) return 'v';
  return 'd';
}
function buyIsVoucherGame(g) {
  if (buyCatOf(g) === 'v') return true;
  return Array.isArray(g.packages) && g.packages.some((p) => p && (p.voucherId || p.fazercardGiftCardId));
}
// Same ordering as the store: explicit `order` ascending, else newest first.
function buyGroups(games, flags, cat) {
  const list = games.filter((g) => {
    const fam = gameProviderFamily(g.fulfillProvider);
    const fl = fam && flags[fam];
    if (fl && (fl.off || fl.soon)) return false;
    return buyCatOf(g) === cat;
  });
  list.sort((a, b) => {
    const oa = typeof a.order === 'number' ? a.order : Infinity;
    const ob = typeof b.order === 'number' ? b.order : Infinity;
    if (oa !== ob) return oa - ob;
    const ta = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
    const tb = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
    return tb - ta;
  });
  const order = []; const map = {};
  list.forEach((g) => {
    const key = (g.name || '').trim().toLowerCase();
    if (!key) return;
    if (!map[key]) { map[key] = { name: g.name, ids: [], servers: [] }; order.push(key); }
    map[key].ids.push(g.id);
    map[key].servers.push(g.serverName || g.name);
  });
  return order.map((k) => map[k]);
}
function buyNeeds(game) {
  const isV = buyIsVoucherGame(game);
  const needsPlayerId = game.playerIdRequired === undefined || game.playerIdRequired === null ? !isV : game.playerIdRequired !== false;
  const opts = (game.fazercardServerMode === 'select' && game.fazercardServerOptions) || (game.g2bulkServerMode === 'select' && game.g2bulkServerOptions);
  const serverOptions = Array.isArray(opts) ? opts.filter((o) => o && o.value !== undefined).map((o) => ({ value: String(o.value), label: String(o.label || o.value) })) : [];
  return {
    isVoucher: isV,
    needsPlayerId,
    needsServer: needsPlayerId && game.serverIdRequired !== false,
    needsChar: needsPlayerId && game.charNameRequired === true,
    serverOptions,
  };
}
function buyPkgs(game) {
  return (Array.isArray(game.packages) ? game.packages : []).map((p, i) => ({ p, i })).filter((x) => x.p && typeof x.p === 'object');
}
function buyTabOf(p) { return (p && (p.tab || p.type)) || 'currency'; }
function buyTabLabel(game, t) {
  const l = game.packageTabLabels || {};
  if (t === 'package') return l.package || 'Package';
  if (t === 'currency') return l.currency || 'Currency';
  return t;
}
function buyTabs(entries) {
  const seen = [];
  entries.forEach(({ p }) => { const t = buyTabOf(p); if (!seen.includes(t)) seen.push(t); });
  return ['currency', 'package', ...seen.filter((t) => t !== 'package' && t !== 'currency')].filter((t) => seen.includes(t));
}
function buyGameLabel(game) { return game.serverName ? `${game.name} (${game.serverName})` : game.name; }

// ---- session ----------------------------------------------------------------
function buyParse(session) { try { return session && session.buy ? JSON.parse(session.buy) : null; } catch (e) { return null; } }
async function buySave(env, telegramId, step, b) { await setBotSession(env, telegramId, { step, buy: JSON.stringify(b) }); }
async function buyReadResume(env, telegramId) {
  try {
    const token = await getFirestoreAccessToken(env);
    const res = await fetch(`${fsBase(env)}/telegramBuyResume/${telegramId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const d = fsDecodeDoc(await res.json());
    if (Date.now() - Number(d.at || 0) > 2 * 60 * 60 * 1000) return null;   // older than 2 h: ignore
    return d.buy ? JSON.parse(d.buy) : null;
  } catch (e) { return null; }
}
async function buyAbort(env, chatId, telegramId) { await deleteFlowMessages(env, chatId); await clearBotSession(env, telegramId); }

// ---- UI helpers ---------------------------------------------------------------
// In-message (rich) buttons are drawn as pills as wide as their text, so a grid looks ragged. Every label in a
// group is padded with invisible Braille blanks (U+2800, never trimmed) to the width of the longest one, so all
// pills in that group come out the same size. Labels longer than `cap` are left alone.
function buyEq(btns, cap = 24) {
  const w = Math.min(cap, Math.max(0, ...btns.map((b) => visualWidth(b.text))));
  return btns.map((b) => {
    const gap = w - visualWidth(b.text);
    if (gap <= 0) return b;
    const l = Math.floor(gap / 2);
    return { ...b, text: BRAILLE_BLANK.repeat(l) + b.text + BRAILLE_BLANK.repeat(gap - l) };
  });
}
function buyGrid(btns, cols) {
  const eq = buyEq(btns);
  const rows = [];
  for (let i = 0; i < eq.length; i += cols) rows.push(eq.slice(i, i + cols));
  return rows;
}
function buyNav(lang, page, pages, cb) {
  if (pages <= 1) return null;
  return [
    page > 0 ? { text: btn(lang, 'prev'), callback_data: cb(page - 1) } : { text: '·', callback_data: 'bg:n' },
    { text: `${page + 1}/${pages}`, callback_data: 'bg:n' },
    page < pages - 1 ? { text: btn(lang, 'next'), callback_data: cb(page + 1) } : { text: '·', callback_data: 'bg:n' },
  ];
}
// One "Stop" button for the whole in-bot buy flow: wipes every message of the flow (cards, price list, typed
// replies), clears the session and goes back to the very beginning. Works at every step, browsing included.
function buyStop(lang) { return styled({ text: bt(lang, '⛔ Stop', '⛔ Stop'), callback_data: 'bg:x' }, 'danger'); }
// Shown to anyone with no account yet: open one right here in the bot (no store login needed) or use the store.
function guestMarkup(lang) {
  return { inline_keyboard: [
    [styled({ text: bt(lang, '✅ Bot ထဲမှာ Account ဖွင့်မည်', '✅ Create account in the bot'), callback_data: 'bg:rg:0:0' }, 'success')],
    [styled({ text: '🚀 Open Linn Game Store', web_app: { url: STORE_URL } }, 'primary')],
  ] };
}
function buyBackCancel(lang, backCb) {
  return [{ text: bt(lang, 'နောက်သို့', 'Back'), callback_data: backCb }, buyStop(lang)];
}
// edit the live card (or send a new one if it vanished)
async function buyShow(env, chatId, b, text, markup) {
  const body = padBubble(text);
  if (b && b.mid) {
    const ok = await editTelegramMessage(env, chatId, b.mid, body, markup);
    if (ok) return b.mid;
  }
  const id = await sendTelegramMessage(env, chatId, body, markup);
  if (b && id) b.mid = id;
  return id;
}
function buySummary(lang, game, pkg, qty, b) {
  const L = [`🎮 ${buyGameLabel(game)}`, `📦 ${pkg.amount}${qty > 1 ? ` × ${qty}` : ''}`, `💰 ${mmk(Number(pkg.price || 0) * qty)}`];
  if (b && b.pid) L.push(`🆔 ${b.pid}${b.sid ? ` (${b.sid})` : ''}`);
  if (b && b.cn) L.push(`🧑 ${b.cn}`);
  if (b && b.nm) L.push(`👤 ${b.nm}`);
  return L.join('\n');
}

// ---- entry points ---------------------------------------------------------------
async function sendBuyCategoryMenu(env, chatId, telegramId) {
  const lang = await getLanguage(env, telegramId);
  await buyAbort(env, chatId, telegramId);   // a fresh Game List always starts from the very beginning
  await buyLiveClear(env, chatId);
  return sendTelegramMessage(env, chatId, padBubble(bt(lang, '🎮 Game List\n\nဝယ်ယူလိုသော အမျိုးအစား ရွေးပါ', '🎮 Game List\n\nChoose a category')), buyCategoryMarkup(lang));
}
function buyCategoryMarkup(lang) {
  return { inline_keyboard: [...['d', 'v', 's'].map((c) => [{ text: BUY_CAT_LABEL[c], callback_data: `bg:l:${c}:0` }]), [buyStop(lang)]] };
}

async function buyShowGames(env, chatId, mid, lang, cat, page) {
  const b = { mid };
  let groups;
  try { const [games, flags] = await Promise.all([buyListGames(env), buyProviderFlags(env)]); groups = buyGroups(games, flags, cat); }
  catch (e) { console.error('buyShowGames failed:', e); return buyShow(env, chatId, b, bt(lang, 'Game list ဖတ်မရပါ။ ခဏနေမှ ပြန်ကြိုးစားပါ။', 'Could not load the game list. Try again shortly.'), { inline_keyboard: [[{ text: bt(lang, 'နောက်သို့', 'Back'), callback_data: 'bg:m' }]] }); }
  if (!groups.length) return buyShow(env, chatId, b, `${BUY_CAT_LABEL[cat]}\n\n${bt(lang, 'ဂိမ်းစာရင်း မရှိသေးပါ။', 'No items yet.')}`, { inline_keyboard: [[{ text: bt(lang, 'နောက်သို့', 'Back'), callback_data: 'bg:m' }]] });
  const pages = Math.ceil(groups.length / BUY_GAMES_PER_PAGE);
  page = Math.min(Math.max(0, page), pages - 1);
  const start = page * BUY_GAMES_PER_PAGE;
  const btns = groups.slice(start, start + BUY_GAMES_PER_PAGE).map((g, i) => ({
    text: g.ids.length > 1 ? `${g.name} (${g.ids.length})` : g.name,
    callback_data: `bg:g:${cat}:${page}:${start + i}`,
  }));
  const rows = buyGrid(btns, 2);
  const nav = buyNav(lang, page, pages, (p) => `bg:l:${cat}:${p}`);
  if (nav) rows.push(nav);
  rows.push([{ text: bt(lang, 'နောက်သို့', 'Back'), callback_data: 'bg:m' }, buyStop(lang)]);
  return buyShow(env, chatId, b, `🎮 ${BUY_CAT_LABEL[cat]}\n\n${bt(lang, `ဂိမ်းတစ်ခု ရွေးပါ (${groups.length})`, `Pick a game (${groups.length})`)}`, { inline_keyboard: rows });
}

async function buyShowServers(env, chatId, mid, lang, cat, page, gi, sp, group) {
  const pages = Math.ceil(group.ids.length / BUY_SERVERS_PER_PAGE);
  sp = Math.min(Math.max(0, sp), pages - 1);
  const start = sp * BUY_SERVERS_PER_PAGE;
  const btns = group.servers.slice(start, start + BUY_SERVERS_PER_PAGE).map((s, i) => ({ text: s, callback_data: `bg:s:${cat}:${page}:${gi}:${start + i}` }));
  const rows = buyGrid(btns, 2);
  const nav = buyNav(lang, sp, pages, (p) => `bg:v:${cat}:${page}:${gi}:${p}`);
  if (nav) rows.push(nav);
  rows.push([{ text: bt(lang, 'နောက်သို့', 'Back'), callback_data: `bg:l:${cat}:${page}` }, buyStop(lang)]);
  return buyShow(env, chatId, { mid }, `🎮 ${group.name}\n\n${bt(lang, `Server / Region ရွေးပါ (${group.ids.length})`, `Pick a server / region (${group.ids.length})`)}`, { inline_keyboard: rows });
}

// Package-type tab colours (Telegram only has green / blue / red). Currency = green, Package = blue,
// any other tab (Double Diamond, ...) = red. Never grey.
const BUY_TAB_STYLE = { currency: 'success', package: 'primary' };
const BUY_TAB_FALLBACK = ['danger', 'success', 'primary'];
function buyTabStyle(t, i) { return BUY_TAB_STYLE[t] || BUY_TAB_FALLBACK[i % BUY_TAB_FALLBACK.length]; }

// ---- catalog: type tabs stay as in-message buttons, the PRICE LIST is its own plain message ---------------
// buyShowCatalog() edits the card (type tabs + Back + Stop) and keeps the price list in separate text message(s),
// tracked as flow messages (Stop / success / a new Game List wipe them). The customer types the package number.
// The open catalog is remembered in telegramBuyLive/{chatId}; the cron tick (refreshLiveBuyCards) re-reads the game
// and edits the price message(s) in place when an amount / price changed. Any other button tap clears it first.
const BUY_LIVE_TTL_MS = 30 * 60 * 1000;
const BUY_PL_CHUNK = 3500;
function buyPriceSig(game) {
  return buyPkgs(game).map(({ p }) => `${buyTabOf(p)}|${p.amount}|${Number(p.price || 0)}`).join(';');
}
async function buyLiveSet(env, chatId, mid, gid, ti, sig, pl) {
  try { await fsSetDoc(env, `telegramBuyLive/${chatId}`, { chatId: String(chatId), mid: Number(mid), gid: String(gid), ti: Number(ti) || 0, pl: (pl || []).join(','), sig, at: Date.now() }); }
  catch (e) { console.error('buyLiveSet failed:', e); }
}
async function buyLiveClear(env, chatId) {
  try { await fsDeleteDoc(env, `telegramBuyLive/${chatId}`); } catch (e) { console.error('buyLiveClear failed:', e); }
}
async function buyDeleteMsgs(env, chatId, ids) {
  if (!ids || !ids.length) return;
  try {
    const res = await tgPost(env, 'deleteMessages', { chat_id: chatId, message_ids: ids });
    if (!res.ok) for (const id of ids) await tgPost(env, 'deleteMessage', { chat_id: chatId, message_id: id }).catch(() => {});
  } catch (e) { console.error('buyDeleteMsgs failed:', e); }
}
async function refreshLiveBuyCards(env) {
  let docs = [];
  try {
    const token = await getFirestoreAccessToken(env);
    const res = await fetch(`${fsBase(env)}/telegramBuyLive?pageSize=200`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    docs = ((await res.json()).documents || []).map(fsDecodeDoc);
  } catch (e) { console.error('refreshLiveBuyCards list failed:', e); return; }
  const now = Date.now();
  const games = new Map();
  for (const d of docs.slice(0, 100)) {
    try {
      if (!d.gid || !d.mid || now - Number(d.at || 0) > BUY_LIVE_TTL_MS) { await buyLiveClear(env, d.id); continue; }
      let game = games.get(d.gid);
      if (game === undefined) { game = await buyGetGame(env, d.gid); games.set(d.gid, game); }
      if (!game) { await buyLiveClear(env, d.id); continue; }
      if (buyPriceSig(game) === d.sig) continue;
      const lang = await getLanguage(env, d.id);
      const pl = String(d.pl || '').split(',').map(Number).filter((n) => n > 0);
      await buyShowCatalog(env, d.chatId || d.id, Number(d.mid), lang, String(d.id), d.gid, Number(d.ti) || 0, { pl });
    } catch (e) { console.error('refreshLiveBuyCards card failed:', e); }
  }
}

// "3", "3.", "3)" and Burmese digits are package / quantity numbers; anything else is not.
function buyParseNum(text) {
  const s = String(text || '').trim().replace(/[၀-၉]/g, (d) => String('၀၁၂၃၄၅၆၇၈၉'.indexOf(d)));
  return /^[0-9]{1,3}\s*[.)]?$/.test(s) ? parseInt(s, 10) : NaN;
}

// numbered price list of ONE type tab; split in several messages only if it would pass Telegram's text limit
function buyPriceTexts(game, tab, list, lang) {
  const head = `🎮 ${buyGameLabel(game)} · ${buyTabLabel(game, tab)}`;
  if (!list.length) return [`${head}\n\n${bt(lang, 'Package မရှိသေးပါ။', 'No packages.')}`];
  const chunks = []; let cur = []; let len = head.length;
  list.forEach(({ p }, n) => {
    const ln = `${n + 1}. ${p.amount} — ${Number(p.price || 0).toLocaleString()} MMK`;
    if (len + ln.length + 1 > BUY_PL_CHUNK && cur.length) { chunks.push(cur); cur = []; len = head.length; }
    cur.push(ln); len += ln.length + 1;
  });
  chunks.push(cur);
  return chunks.map((c, i) => `${head}${chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ''}\n\n${c.join('\n')}`);
}

// live = null for a customer tap; { pl: [ids] } when the cron tick refreshes the price messages (never sends new ones)
async function buyShowCatalog(env, chatId, mid, lang, telegramId, gid, ti, live) {
  const b = { mid };
  const game = await buyGetGame(env, gid);
  if (!game) {
    if (live) { await buyLiveClear(env, chatId); return null; }
    return buyShow(env, chatId, b, bt(lang, 'ဤဂိမ်းကို မတွေ့ရှိပါ။', 'Game not found.'), { inline_keyboard: [[{ text: 'Game List', callback_data: 'bg:m' }, buyStop(lang)]] });
  }
  const entries = buyPkgs(game);
  const tabs = buyTabs(entries);
  ti = Math.min(Math.max(0, ti), Math.max(0, tabs.length - 1));
  const tab = tabs[ti] || 'currency';
  const list = entries.filter(({ p }) => buyTabOf(p) === tab);
  const texts = buyPriceTexts(game, tab, list, lang);
  const sig = kbHash(texts.join('\u0001'));

  const sess = await getBotSession(env, telegramId);
  const old = sess && sess.step === 'buy_pick' ? buyParse(sess) : null;
  const sameGame = !!old && old.gid === gid;
  if (live && !sameGame) { await buyLiveClear(env, chatId); return null; }   // the customer already moved on
  let ids = live && Array.isArray(live.pl) && live.pl.length ? live.pl.slice() : (sameGame && Array.isArray(old.pl) ? old.pl.slice() : []);
  const prevSig = sameGame ? old.sig : '';

  // price list message(s): edit in place when the count is unchanged, otherwise delete + resend
  if (!(ids.length === texts.length && prevSig === sig)) {
    let ok = ids.length > 0 && ids.length === texts.length;
    for (let k = 0; ok && k < texts.length; k++) ok = await editTelegramMessage(env, chatId, ids[k], texts[k], null);
    if (!ok) {
      if (live) { await buyLiveClear(env, chatId); return null; }
      await buyDeleteMsgs(env, chatId, ids);
      ids = [];
      for (const tx of texts) { const id = await sendFlowMessage(env, chatId, tx); if (id) ids.push(id); }
    }
  }
  const mapList = list.map(({ p, i }) => [i, String(p.amount)]);

  if (live) {
    await buySave(env, telegramId, 'buy_pick', { ...old, pl: ids, sig, list: mapList });
    await buyLiveSet(env, chatId, mid, gid, ti, buyPriceSig(game), ids);
    return mid;
  }

  // the card: type tabs (2 per row, each its own colour, open one marked "•") + Back + Stop
  const rows = [];
  if (tabs.length > 1) buyGrid(tabs.map((t, i) => styled({ text: `${i === ti ? '• ' : ''}${buyTabLabel(game, t)}`, callback_data: `bg:k:${gid}:${i}` }, buyTabStyle(t, i))), 2).forEach((r) => rows.push(r));
  rows.push([{ text: bt(lang, 'နောက်သို့', 'Back'), callback_data: `bg:b:${gid}` }, buyStop(lang)]);
  const lines = [`🎮 ${buyGameLabel(game)}`, ''];
  if (tabs.length > 1) lines.push(bt(lang, 'Package အမျိုးအစား ရွေးပါ ↓', 'Pick a package type ↓'), '');
  lines.push(list.length
    ? bt(lang, `Price List message ကို ကြည့်ပြီး ယူမယ့် Package ရဲ့ နံပါတ် (1–${list.length}) ကို ရိုက်ပို့ပါ`, `Check the price list message, then type the package number (1–${list.length})`)
    : bt(lang, 'ဒီအမျိုးအစားမှာ Package မရှိသေးပါ။', 'No packages in this type yet.'));
  const out = await buyShow(env, chatId, b, lines.join('\n'), { inline_keyboard: rows });
  const cardId = out || mid;
  await buySave(env, telegramId, 'buy_pick', { gid, ti, mid: cardId, pl: ids, sig, list: mapList });
  await buyLiveSet(env, chatId, cardId, gid, ti, buyPriceSig(game), ids);
  return cardId;
}
async function buyEnterCatalog(env, chatId, mid, lang, telegramId, gid) {
  await buyAbort(env, chatId, telegramId);   // clean slate: no leftover price messages / session
  return buyShowCatalog(env, chatId, mid, lang, telegramId, gid, 0, null);
}

// ---- ID parsing ---------------------------------------------------------------------
// "123456789(2001)", "123456789 2001", "123456789 - 2001", "123456789 🔥 2001" all work:
// everything that is not a letter/digit is a separator.
function buyParseIds(text, needsServer, hasOptions) {
  const clean = String(text || '').replace(/[\u1000-\u109F\uA9E0-\uA9FF\uAA60-\uAA7F]/g, ' ');
  const toks = clean.match(/[A-Za-z0-9]+/g) || [];
  if (!toks.length) return { ok: false, reason: 'empty' };
  if (!needsServer) {
    const whole = clean.trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (whole && !/\s/.test(whole) && whole.length <= 64) return { ok: true, id: whole, sid: '' };
    return toks.length === 1 ? { ok: true, id: toks[0], sid: '' } : { ok: false, reason: 'many' };
  }
  if (toks.length === 1) return hasOptions ? { ok: true, id: toks[0], sid: '' } : { ok: false, reason: 'server_missing' };
  if (toks.length === 2) return { ok: true, id: toks[0], sid: toks[1] };
  return { ok: false, reason: 'many' };
}

// ---- Name check -------------------------------------------------------------------------
async function buyCheckName(game, pid, sid, charName) {
  try {
    if (game.g2bulkCode) {
      let res;
      try {
        res = await fetch('https://api.g2bulk.com/v1/games/checkPlayerId', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game: game.g2bulkCode, user_id: pid, server_id: sid || undefined, charname: charName || undefined }),
        });
      } catch (e) { return { outcome: 'unknown' }; }
      let data = null; try { data = await res.json(); } catch (e) { data = null; }
      const msg = String((data && (data.message || data.error || data.detail || data.msg)) || '');
      const srv = /server|zone|region/i.test(msg);
      const valid = !!data && (data.valid === 'valid' || data.valid === true);
      if (res.ok) {
        // Games with no name lookup (Genshin, ZZZ...) answer "valid" with a placeholder text instead of a name - never store that as the player name.
        if (valid && /no\s+validation/i.test(String(data.name || ''))) return { outcome: 'none' };
        return valid ? { outcome: 'valid', name: String(data.name || '').trim().slice(0, 40) } : { outcome: 'invalid', reason: srv ? 'server' : 'id' };
      }
      if (res.status === 400 && /required|missing|unsupported|not supported|unknown game|invalid game/i.test(msg)) return { outcome: 'unknown' };
      if (res.status === 400 || res.status === 404 || res.status === 422) return { outcome: 'invalid', reason: srv ? 'server' : 'id' };
      if (res.status === 403 && srv) return { outcome: 'invalid', reason: 'server' };
      return { outcome: 'unknown' };
    }
    if (game.fazercardCategoryId) {
      const keys = Array.isArray(game.fazercardFields) && game.fazercardFields.length ? game.fazercardFields : ['player_id'];
      const fields = {};
      keys.forEach((k) => { fields[k] = /server|zone/i.test(k) ? sid : pid; });
      const res = await fetch(BUY_FAZER_VALIDATE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categoryId: game.fazercardCategoryId, fields }) });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.ok) return { outcome: 'unknown' };
      return data.valid === true ? { outcome: 'valid', name: String(data.playerName || '').trim().slice(0, 40) } : { outcome: 'invalid', reason: 'id' };
    }
  } catch (e) { console.error('buyCheckName failed:', e); return { outcome: 'unknown' }; }
  return { outcome: 'none' };
}

async function buyRunNameCheck(env, chatId, telegramId, b, game, pkg, lang) {
  await buyShow(env, chatId, b, bt(lang, '🔎 Name စစ်ဆေးနေပါတယ်...', '🔎 Checking name...'), null);
  const r = await buyCheckName(game, b.pid, b.sid, b.cn);
  const idLine = `🆔 ${b.pid}${b.sid ? ` (${b.sid})` : ''}`;
  const idBtn = { text: bt(lang, 'ID ပြင်မည်', 'Change ID'), callback_data: 'bg:id' };
  const cancel = buyStop(lang);
  if (r.outcome === 'invalid') {
    b.nm = ''; b.nc = '';
    await buySave(env, telegramId, 'buy_id', b);
    const why = r.reason === 'server'
      ? bt(lang, 'Server ID မှားနေပါတယ်', 'The Server ID looks wrong')
      : bt(lang, 'ဒီ ID ကို မတွေ့ပါ', 'This ID was not found');
    return buyShow(env, chatId, b, `❌ ${why}\n${idLine}\n\n${bt(lang, 'ID ကို ပြန်စစ်ပြီး ထပ်ပို့ပါ', 'Check it and send the ID again')}`, { inline_keyboard: [buyBackCancel(lang, `bg:ba:${b.gid}`)] });
  }
  if (r.outcome === 'unknown') {
    b.nm = ''; b.nc = 'unknown';
    await buySave(env, telegramId, 'buy_id', b);
    return buyShow(env, chatId, b, `⚠️ ${bt(lang, 'Name စစ်လို့ မရသေးပါ (Service ခဏ ပြတ်နေနိုင်ပါတယ်)', 'Name check is unavailable right now')}\n${idLine}`, {
      inline_keyboard: [
        [styled({ text: bt(lang, 'ပြန်စစ်မည်', 'Check again'), callback_data: 'bg:rc' }, 'primary'), { text: bt(lang, 'ဆက်ဝယ်မည်', 'Continue anyway'), callback_data: 'bg:go' }],
        [idBtn, cancel],
      ],
    });
  }
  b.nm = r.name || ''; b.nc = r.outcome;
  return buyShowPayChoice(env, chatId, telegramId, b, game, pkg, lang, r.outcome === 'none');
}

async function buyShowPayChoice(env, chatId, telegramId, b, game, pkg, lang, noCheck) {
  const acct = await lookupAccountByTelegramId(env, telegramId);
  const bal = Number(acct && acct.walletBalance) || 0;
  await buySave(env, telegramId, 'buy_pay', b);
  const head = b.nm ? bt(lang, '✅ Name ရှာတွေ့ပါပြီ', '✅ Player found') : (noCheck ? bt(lang, 'ℹ️ ဒီဂိမ်းမှာ Name Check မရနိုင်ပါ — ID ကို ကိုယ်တိုင် ပြန်စစ်ပါ', 'ℹ️ No name check for this game — double-check your ID') : bt(lang, '🧾 Order အချက်အလက်', '🧾 Order details'));
  const text = `${head}\n\n${buySummary(lang, game, pkg, b.qty || 1, b)}\n💼 Wallet: ${mmk(bal)}\n\n${bt(lang, 'ငွေပေးချေမည့်နည်း ရွေးပါ', 'Choose how to pay')}`;
  const rows = [[styled({ text: 'Wallet', callback_data: 'bg:w' }, 'success'), styled({ text: 'Payment', callback_data: 'bg:pay' }, 'primary')]];
  rows.push(b.pid ? [{ text: bt(lang, 'ID ပြင်မည်', 'Change ID'), callback_data: 'bg:id' }, buyStop(lang)] : [buyStop(lang)]);
  return buyShow(env, chatId, b, text, { inline_keyboard: rows });
}

async function buyPromptId(env, chatId, telegramId, b, game, pkg, lang, errNote) {
  const n = buyNeeds(game);
  const ex = n.needsServer && !n.serverOptions.length
    ? bt(lang, 'ဥပမာ: 123456789(2001)\nID နဲ့ Server ကြားမှာ space၊ ( )၊ - စတဲ့ ပုံစံ ဘာခြားခြား ရပါတယ်', 'Example: 123456789(2001)\nAny separator between ID and Server works (space, brackets, -)')
    : bt(lang, 'ဥပမာ: 123456789', 'Example: 123456789');
  b.nm = ''; b.nc = '';
  await buySave(env, telegramId, 'buy_id', b);
  const text = `${errNote ? `${errNote}\n\n` : ''}${buySummary(lang, game, pkg, b.qty || 1, null)}\n\n${bt(lang, '🆔 Game ID ကို ပို့ပါ', '🆔 Send your Game ID')}\n${ex}`;
  return buyShow(env, chatId, b, text, { inline_keyboard: [buyBackCancel(lang, `bg:ba:${b.gid}`)] });
}

async function buyAfterQty(env, chatId, telegramId, b, game, pkg, lang, note) {
  const n = buyNeeds(game);
  if (!n.needsPlayerId) { b.pid = ''; b.sid = ''; return buyShowPayChoice(env, chatId, telegramId, b, game, pkg, lang, false); }
  return buyPromptId(env, chatId, telegramId, b, game, pkg, lang, note || '');
}

// after ID(+server) known: server buttons (select-mode) -> char name -> name check
async function buyAfterIds(env, chatId, telegramId, b, game, pkg, lang) {
  const n = buyNeeds(game);
  if (n.needsServer && n.serverOptions.length && !b.sid) {
    await buySave(env, telegramId, 'buy_srv', b);
    const btns = n.serverOptions.slice(0, 40).map((o, i) => ({ text: o.label, callback_data: `bg:so:${i}` }));
    return buyShow(env, chatId, b, `${buySummary(lang, game, pkg, b.qty || 1, b)}\n\n${bt(lang, 'Server / Region ရွေးပါ', 'Pick the server / region')}`, { inline_keyboard: [...buyGrid(btns, 2), buyBackCancel(lang, 'bg:id')] });
  }
  if (n.needsChar && !b.cn) {
    await buySave(env, telegramId, 'buy_char', b);
    return buyShow(env, chatId, b, `${buySummary(lang, game, pkg, b.qty || 1, b)}\n\n${bt(lang, '🧑 Character Name ကို ပို့ပါ', '🧑 Send your Character Name')}`, { inline_keyboard: [buyBackCancel(lang, 'bg:id')] });
  }
  return buyRunNameCheck(env, chatId, telegramId, b, game, pkg, lang);
}

// ---- package number -> (account check / register) -> quantity -> ID -> name check -> order ----------------
async function buyPromptQty(env, chatId, telegramId, b, game, pkg, lang, note) {
  await buySave(env, telegramId, 'buy_qty', b);
  return buyShow(env, chatId, b, `${note ? `${note}\n\n` : ''}${buySummary(lang, game, pkg, 1, null)}\n\n${bt(lang, '🔢 အရေအတွက် ကို နံပါတ်နဲ့ ပို့ပါ (၁ ကနေ ၁၀)', '🔢 Send the quantity as a number (1–10)')}`, { inline_keyboard: [buyBackCancel(lang, `bg:ba:${b.gid}`)] });
}

// the customer typed a package number under the price list
async function buyHandlePick(env, chatId, telegramId, b, text, lang) {
  const list = Array.isArray(b.list) ? b.list : [];
  const n = buyParseNum(text);
  if (!(n >= 1 && n <= list.length)) {
    return sendFlowMessage(env, chatId, bt(lang, `⚠️ Price List ထဲက နံပါတ် (1–${list.length}) ကိုပဲ ရိုက်ပို့ပါ`, `⚠️ Type a number from the price list (1–${list.length})`));
  }
  const [pi, amount] = list[n - 1];
  const game = await buyGetGame(env, b.gid);
  const pkg = game && Array.isArray(game.packages) ? game.packages[pi] : null;
  if (!game || !pkg || String(pkg.amount) !== String(amount)) {
    await sendFlowMessage(env, chatId, bt(lang, '🔄 Price List ပြောင်းသွားလို့ အသစ်ပြန်ပြထားပါတယ်။ နံပါတ်ကို ပြန်ရွေးပါ။', '🔄 The price list changed and was refreshed. Please pick the number again.'));
    return buyShowCatalog(env, chatId, b.mid, lang, telegramId, b.gid, b.ti || 0, null);
  }
  return buyStartPurchase(env, chatId, telegramId, b.mid, lang, b.gid, pi, '');
}

// package chosen: software -> admin chat; no account -> register card; otherwise quantity (voucher) or Game ID
async function buyStartPurchase(env, chatId, telegramId, mid, lang, gid, pi, note) {
  const game = await buyGetGame(env, gid);
  const pkg = game && Array.isArray(game.packages) ? game.packages[pi] : null;
  if (!game || !pkg || typeof pkg !== 'object') return buyShowCatalog(env, chatId, mid, lang, telegramId, gid || '', 0, null);
  if (game.fulfillProvider === 'software') {
    const msgText = ['🛒 Software Order', '', `📦 Item: ${buyGameLabel(game)} — ${pkg.amount}`, '🔢 Quantity: 1', `💰 Price: ${mmk(pkg.price)}`].join('\n');
    return buyShow(env, chatId, { mid }, `🛒 ${buyGameLabel(game)}\n📦 ${pkg.amount}\n💰 ${mmk(pkg.price)}\n\n${bt(lang, 'Software ကို Admin ဆီ Telegram ကနေ မှာယူရပါမယ် — အောက်ခလုတ်ကို နှိပ်ပြီး Send နှိပ်ပါ။', 'Software is ordered via the admin on Telegram — tap below, then Send.')}`, {
      inline_keyboard: [[styled({ text: bt(lang, 'Telegram ကနေ မှာမည်', 'Order via Telegram'), url: `https://t.me/${BUY_SOFTWARE_ADMIN}?text=${encodeURIComponent(msgText)}` }, 'success')], [{ text: bt(lang, 'နောက်သို့', 'Back'), callback_data: `bg:kb:${gid}:0` }, buyStop(lang)]],
    });
  }
  const acct = await lookupAccountByTelegramId(env, telegramId);
  if (!acct) {
    return buyShow(env, chatId, { mid }, `👤 ${bt(lang, 'Account မရှိသေးပါ', 'No account yet')}\n\n${bt(lang, 'Store ထဲ မဝင်ဘဲ ဒီ Bot ထဲမှာပဲ Account ဖွင့်ပြီး ဆက်ဝယ်လို့ရပါတယ်။ သင့် Telegram အချက်အလက်နဲ့ Account တစ်ခု ချက်ချင်း ဖွင့်ပေးပါမယ်။', 'You can open an account right here in the bot and keep buying — no store login needed. It is created from your Telegram details.')}\n\n🎮 ${buyGameLabel(game)}\n📦 ${pkg.amount}`, {
      inline_keyboard: [[styled({ text: bt(lang, '✅ Account ဖွင့်မည်', '✅ Create account'), callback_data: `bg:rg:${gid}:${pi}` }, 'success')], [{ text: bt(lang, 'နောက်သို့', 'Back'), callback_data: `bg:kb:${gid}:0` }, buyStop(lang)]],
    });
  }
  await buyLiveClear(env, chatId);
  await buyAbort(env, chatId, telegramId);   // price list + the typed number are no longer needed
  const b = { gid, pi, qty: 1, mid };
  const n = buyNeeds(game);
  if (n.isVoucher && pkg.voucherId) return buyPromptQty(env, chatId, telegramId, b, game, pkg, lang, note);
  return buyAfterQty(env, chatId, telegramId, b, game, pkg, lang, note);
}

// Open an account for this Telegram user from inside the bot. Re-uses an existing linked account, links an
// existing user doc that already records this verified Telegram id (same safety rules as the website login),
// and only then creates a brand-new users/{id} + telegramAccounts/tg_<id> link. The Telegram identity comes from
// Telegram's own update, so it cannot be forged by the customer.
const BUY_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // same alphabet as worker.js makeServerGuestId (no L)
async function botRegisterAccount(env, from) {
  const tgId = String(from.id);
  let acct = await lookupAccountByTelegramId(env, tgId);
  if (acct) return { acct, created: false };
  await autoLinkTelegramGuest(env, from, '');
  acct = await lookupAccountByTelegramId(env, tgId);
  if (acct) return { acct, created: false };
  await notifyAdminNewTelegramUser(env, from, 'Bot Register');   // must run before the link doc exists
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Player';
  for (let attempt = 0; attempt < 5; attempt++) {
    const rnd = crypto.getRandomValues(new Uint8Array(8));
    const guestId = 'LINN-' + Array.from(rnd, (x) => BUY_ID_ALPHABET[x % BUY_ID_ALPHABET.length]).join('');
    const now = new Date();
    // exactly the fields worker.js handleAccountCreate() writes for a Telegram account
    const ok = await fsCreateDocOnce(env, 'users', guestId, {
      guestId, name: name.slice(0, 100), phone: '', photo: '', createdAt: now, lastSeen: now,
      telegramId: tgId, telegramUsername: String(from.username || '').slice(0, 64), authUid: `tg_${tgId}`,
    });
    if (!ok) continue;
    await fsSetDoc(env, `telegramAccounts/tg_${tgId}`, { guestId, telegramId: tgId, linkedAt: new Date() });
    return { acct: await lookupAccountByTelegramId(env, tgId), created: true };
  }
  return { acct: null, created: false };
}

// ---- text + photo routers (called from routeTelegramMessage / routeTelegramPhoto) -----------
async function handleBuyText(env, msg, session, lang) {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from.id);
  const text = (msg.text || '').trim();
  await trackFlowMessage(env, chatId, msg.message_id);
  const b = buyParse(session);
  if (!b) return sendTelegramMessage(env, chatId, t(lang, 'sessionGone'), MAIN_KEYBOARD);
  if (session.step === 'buy_pick') return buyHandlePick(env, chatId, telegramId, b, text, lang);   // package number from the price list
  if (session.step !== 'buy_id' && session.step !== 'buy_char' && session.step !== 'buy_qty') return;   // other steps use buttons
  const game = await buyGetGame(env, b.gid);
  const pkg = game && Array.isArray(game.packages) ? game.packages[b.pi] : null;
  if (!game || !pkg) return buyShow(env, chatId, b, bt(lang, 'ဂိမ်း/Package မတွေ့တော့ပါ။ Game List ကနေ ပြန်စပါ။', 'Game/package is gone. Start again from Game List.'), null);

  if (session.step === 'buy_qty') {
    const q = buyParseNum(text);
    if (!(q >= 1 && q <= 10)) return buyPromptQty(env, chatId, telegramId, b, game, pkg, lang, bt(lang, '⚠️ ၁ ကနေ ၁၀ ကြား နံပါတ်တစ်ခုပဲ ပို့ပါ', '⚠️ Send one number from 1 to 10'));
    b.qty = q;
    return buyAfterQty(env, chatId, telegramId, b, game, pkg, lang, '');
  }
  if (session.step === 'buy_char') {
    b.cn = text.slice(0, 40);
    return buyRunNameCheck(env, chatId, telegramId, b, game, pkg, lang);
  }
  const n = buyNeeds(game);
  const r = buyParseIds(text, n.needsServer, n.serverOptions.length > 0);
  if (!r.ok) {
    const note = r.reason === 'server_missing'
      ? bt(lang, '⚠️ Server ID လည်း ထည့်ပေးပါ (ဥပမာ 123456789(2001))', '⚠️ Please include the Server ID too (e.g. 123456789(2001))')
      : r.reason === 'many'
        ? bt(lang, n.needsServer ? '⚠️ ID နဲ့ Server ID နှစ်ခုပဲ ပို့ပါ' : '⚠️ ဒီဂိမ်းက Server ID မလိုပါ — ID တစ်ခုတည်း ပို့ပါ', n.needsServer ? '⚠️ Send just the ID and the Server ID' : '⚠️ This game needs no Server ID — send the ID only')
        : bt(lang, '⚠️ ID မမှန်ပါ — စာလုံး/ဂဏန်းနဲ့ ပို့ပါ', '⚠️ Invalid ID — use letters/digits');
    return buyPromptId(env, chatId, telegramId, b, game, pkg, lang, `${note}\n“${text.slice(0, 40)}”`);
  }
  b.pid = r.id; b.sid = r.sid; b.cn = '';
  if (r.sid && n.serverOptions.length && !n.serverOptions.some((o) => o.value === r.sid)) {
    const hit = n.serverOptions.find((o) => o.label.toLowerCase() === r.sid.toLowerCase());
    if (hit) b.sid = hit.value; else b.sid = '';
  }
  return buyAfterIds(env, chatId, telegramId, b, game, pkg, lang);
}

async function handleBuyReceiptPhoto(env, msg, session, ctx) {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from.id);
  const lang = await getLanguage(env, telegramId);
  const b = buyParse(session);
  await trackFlowMessage(env, chatId, msg.message_id);
  if (!b || b.pay !== 'bank') return sendTelegramMessage(env, chatId, t(lang, 'topupExpired'), MAIN_KEYBOARD);
  const game = await buyGetGame(env, b.gid);
  const pkg = game && Array.isArray(game.packages) ? game.packages[b.pi] : null;
  if (!game || !pkg) return buyShow(env, chatId, b, bt(lang, 'ဂိမ်း/Package မတွေ့တော့ပါ။', 'Game/package is gone.'), null);
  const fileId = msg.photo[msg.photo.length - 1].file_id;
  await buyShow(env, chatId, b, bt(lang, '⏳ ပုံ လက်ခံနေပါတယ်...', '⏳ Receiving your receipt...'), null);
  try {
    b.rf = await uploadTelegramPhotoToImgBB(env, fileId);
  } catch (e) {
    console.error('buy receipt upload failed:', e);
    if (ctx) ctx.waitUntil(alertAdmin(env, `Bot order receipt upload failed for ${telegramId}`, e));
    b.rf = '';
    await buySave(env, telegramId, 'buy_receipt', b);
    return buyShow(env, chatId, b, bt(lang, '⚠️ ပုံတင်လို့ မရပါ။ Screenshot ကို ထပ်ပို့ပါ။', '⚠️ Upload failed. Please send the screenshot again.'), { inline_keyboard: [buyBackCancel(lang, 'bg:pay')] });
  }
  await buySave(env, telegramId, 'buy_receipt', b);
  return buyShow(env, chatId, b, `🖼 ${bt(lang, 'ပုံ လက်ခံရရှိပါပြီ', 'Receipt received')}\n\n${buySummary(lang, game, pkg, b.qty || 1, b)}\n💳 ${b.pm}\n\n${bt(lang, 'ငွေလွဲပြီးကြောင်း အတည်ပြုရန် Confirm နှိပ်ပါ', 'Tap Confirm to say you have paid')}`, {
    inline_keyboard: [
      [styled({ text: bt(lang, 'Confirm — ငွေလွဲပြီးပါပြီ', 'Confirm — I have paid'), callback_data: 'bg:cr' }, 'success')],
      [{ text: bt(lang, 'ပုံပြန်ပို့မည်', 'Send another photo'), callback_data: 'bg:rp' }, buyStop(lang)],
    ],
  });
}

// ---- order worker call ---------------------------------------------------------------------
async function buyOrderFetch(env, path, init) {
  if (env.ORDER_WORKER && typeof env.ORDER_WORKER.fetch === 'function') return env.ORDER_WORKER.fetch(`https://order-worker.internal${path}`, init);
  return fetch(`${env.ORDER_WORKER_URL || COUPON_WORKER_URL}${path}`, init);
}
async function buyFirebaseIdToken(env, from) {
  const custom = await mintFirebaseToken(env, { id: from.id, username: from.username });
  const key = firebaseWebKey(env);
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.idToken) throw new Error(`signInWithCustomToken failed (${res.status})`);
  return j.idToken;
}
const _b64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
let _buyPub = null;
async function buySeal(env, path, uid, data) {
  if (!_buyPub) {
    const r = await buyOrderFetch(env, '/security/key', { method: 'GET', headers: { Origin: STORE_URL } });
    const j = await r.json();
    if (!j.ok) throw new Error('no security key');
    _buyPub = await crypto.subtle.importKey('jwk', j.jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  }
  const enc = (s) => new TextEncoder().encode(s);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: _buyPub }, eph.privateKey, 256);
  const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc('linn-sec-v1') }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const n = _b64(crypto.getRandomValues(new Uint8Array(16))).replace(/[^A-Za-z0-9]/g, '');
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc(`${path}|${uid}`) }, key, enc(JSON.stringify({ ...data, n, t: Date.now() })));
  return { epk: _b64(await crypto.subtle.exportKey('raw', eph.publicKey)), iv: _b64(iv), ct: _b64(ct) };
}
async function buySha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function buyCreateOrder(env, from, acct, game, pkg, b, mode) {
  const qty = Math.max(1, Math.floor(Number(b.qty) || 1));
  const total = Number(pkg.price || 0) * qty;
  if (!Number.isFinite(total) || total < 0) throw new Error('bad price');
  const unit = Math.round(total / qty);
  const orderCode = (await buySha256Hex([game.name, game.serverName || '', pkg.amount, unit].map((v) => String(v === undefined || v === null ? '' : v)).join('|'))).slice(0, 16);
  const body = {
    playerId: b.pid || '', serverId: b.sid || '', ...(b.cn ? { charName: b.cn } : {}),
    serverRegion: game.serverName || '', ...(b.nm ? { inGameName: b.nm } : {}),
    game: game.name, itemAmount: pkg.amount, price: total, quantity: qty, userId: acct.guestId, orderCode,
    ...(game.g2bulkCode && pkg.g2bulk ? { g2bulkGameCode: game.g2bulkCode, g2bulkCatalogueName: pkg.g2bulk } : {}),
    ...(game.jcplaysProduct && pkg.jcplays ? { jcplaysProduct: game.jcplaysProduct, jcplaysProductId: pkg.jcplays } : {}),
    ...(pkg.voucherId ? { g2bulkVoucherProductId: pkg.voucherId } : {}),
    ...(game.fazercardCategoryId && pkg.fazercardOfferId ? { fazercardCategoryId: game.fazercardCategoryId, fazercardOfferId: pkg.fazercardOfferId } : {}),
    ...(game.fazercardGiftCategoryId && pkg.fazercardGiftCardId ? { fazercardGiftCategoryId: game.fazercardGiftCategoryId, fazercardGiftCardId: pkg.fazercardGiftCardId } : {}),
    ...(mode === 'wallet' ? { paidFromWallet: true, paymentMethod: 'Wallet Balance' } : { paymentMethod: b.pm, receiptUrl: b.rf }),
  };
  const uid = `tg_${from.id}`;
  const idToken = await buyFirebaseIdToken(env, from);
  const devHash = (await buySha256Hex(`tgbot|${from.id}`)).slice(0, 32);
  let res, j;
  for (let attempt = 0; attempt < 2; attempt++) {
    let sealed;
    try { sealed = await buySeal(env, '/orders/create', uid, body); } catch (e) { _buyPub = null; throw e; }
    res = await buyOrderFetch(env, '/orders/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}`, 'X-Dev': devHash, Origin: STORE_URL },
      body: JSON.stringify({ sealed }),
    });
    j = await res.json().catch(() => ({}));
    if (j && j.retry && attempt === 0) { _buyPub = null; continue; }
    break;
  }
  return { status: res.status, ...(j || {}), total };
}

// One order at a time per customer (a double-tap used to be able to place two orders / debit twice).
async function buyLockTake(env, tid) {
  try {
    if (await fsCreateDocOnce(env, 'telegramBuyLocks', tid, { at: Date.now() })) return true;
    const token = await getFirestoreAccessToken(env);
    const res = await fetch(`${fsBase(env)}/telegramBuyLocks/${tid}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) { const d = fsDecodeDoc(await res.json()); if (Date.now() - Number(d.at || 0) < 90000) return false; }
    await fsDeleteDoc(env, `telegramBuyLocks/${tid}`);
    return await fsCreateDocOnce(env, 'telegramBuyLocks', tid, { at: Date.now() });
  } catch (e) { console.error('buyLockTake failed:', e); return false; }   // fail CLOSED: without the lock a double-tap could place / debit twice, so ask the customer to retry
}
async function buyLockFree(env, tid) { try { await fsDeleteDoc(env, `telegramBuyLocks/${tid}`); } catch (e) {} }
async function buyPlaceOrder(env, ctx, cq, b, mode, lang) {
  const tid = String(cq.from.id);
  if (!(await buyLockTake(env, tid))) return answerCallbackQuery(env, cq.id, bt(lang, 'ခဏစောင့်ပြီး ပြန်နှိပ်ပါ...', 'One moment, then tap again...'));
  try { return await buyPlaceOrderRun(env, ctx, cq, b, mode, lang); }
  finally { await buyLockFree(env, tid); }
}
async function buyPlaceOrderRun(env, ctx, cq, b, mode, lang) {
  const chatId = cq.message.chat.id;
  const telegramId = String(cq.from.id);
  if (b.busy && Date.now() - b.busy < 60000) return answerCallbackQuery(env, cq.id, bt(lang, 'ခဏစောင့်ပါ...', 'One moment...'));
  const lim = await checkRateLimit(env, telegramId, 'buy_order', { maxCount: 10, windowMs: 60 * 60 * 1000 });
  if (lim.limited) return answerCallbackQuery(env, cq.id, bt(lang, 'Order များလွန်းပါတယ်။ ခဏနေမှ ပြန်ကြိုးစားပါ။', 'Too many orders. Try again later.'), true);
  await answerCallbackQuery(env, cq.id);
  const game = await buyGetGame(env, b.gid);
  const pkg = game && Array.isArray(game.packages) ? game.packages[b.pi] : null;
  const acct = await lookupAccountByTelegramId(env, telegramId);
  if (!game || !pkg || !acct) return buyShow(env, chatId, b, bt(lang, 'Order မတင်နိုင်ပါ (ဂိမ်း/Account မတွေ့)။ Game List ကနေ ပြန်စပါ။', 'Cannot place order (game/account missing). Start again.'), null);
  b.busy = Date.now();
  await buySave(env, telegramId, mode === 'wallet' ? 'buy_pay' : 'buy_receipt', b);
  await buyShow(env, chatId, b, bt(lang, '⏳ Order တင်နေပါတယ်...', '⏳ Placing your order...'), null);

  let r;
  try { r = await buyCreateOrder(env, cq.from, acct, game, pkg, b, mode); }
  catch (e) {
    console.error('buyCreateOrder failed:', e);
    if (ctx) ctx.waitUntil(alertAdmin(env, `Bot order failed for ${telegramId}`, e));
    r = { ok: false, error: 'SERVICE' };
  }
  const miniUrl = `${STORE_URL}?game=${encodeURIComponent(b.gid)}`;
  const miniBtn = { text: bt(lang, 'Mini App ထဲမှာ ဝယ်မည်', 'Buy in Mini App'), web_app: { url: miniUrl } };
  const retryRow = mode === 'wallet'
    ? [[styled({ text: btn(lang, 'retry'), callback_data: 'bg:cw' }, 'primary')], buyBackCancel(lang, 'bg:bk')]
    : [[styled({ text: btn(lang, 'retry'), callback_data: 'bg:cr' }, 'primary'), { text: bt(lang, 'ပုံပြန်ပို့မည်', 'Send another photo'), callback_data: 'bg:rp' }], [buyStop(lang)]];
  b.busy = 0;
  if (!r.ok) {
    await buySave(env, telegramId, mode === 'wallet' ? 'buy_pay' : 'buy_receipt', b);
    if (r.securityRequired) return buyShow(env, chatId, b, bt(lang, '🔐 Security Code / Authenticator လိုအပ်ပါတယ်။ ဒီ Order ကို Mini App ထဲမှာ ဝယ်ပေးပါ။', '🔐 A Security Code / Authenticator is required. Please buy this one in the Mini App.'), { inline_keyboard: [[miniBtn], [buyStop(lang)]] });
    if (r.loginRequired || r.sessionRevoked) return buyShow(env, chatId, b, bt(lang, '🔒 Login ပြန်ဝင်ရန် လိုပါတယ်။ Mini App ကို ဖွင့်ပါ။', '🔒 Please log in again via the Mini App.'), { inline_keyboard: [[miniBtn]] });
    if (r.error === 'INSUFFICIENT_BALANCE') return buyShow(env, chatId, b, bt(lang, '⚠️ Wallet လက်ကျန်ငွေ မလောက်ပါ။', '⚠️ Not enough wallet balance.'), { inline_keyboard: [[styled({ text: bt(lang, 'Wallet ဖြည့်မည်', 'Top up wallet'), callback_data: 'bg:tu' }, 'success'), styled({ text: 'Payment', callback_data: 'bg:pay' }, 'primary')], buyBackCancel(lang, 'bg:bk')] });
    const msgTxt = r.error && r.error !== 'SERVICE' ? String(r.error).slice(0, 300) : bt(lang, 'Order စနစ် ခဏ ပြတ်နေပါတယ်။ ခဏနေမှ ထပ်ကြိုးစားပါ။', 'The order system is busy. Please try again shortly.');
    return buyShow(env, chatId, b, `❌ ${bt(lang, 'Order မအောင်မြင်ပါ', 'Order failed')}\n\n${msgTxt}`, { inline_keyboard: retryRow });
  }

  // success: wipe the temporary flow messages, turn the card into the receipt
  await deleteFlowMessages(env, chatId);
  await clearBotSession(env, telegramId);
  const id = String(r.id);
  const text = `✅ ${bt(lang, 'Order တင်ပြီးပါပြီ', 'Order placed')}\n\n🔖 Order ID: #${id}\n${buySummary(lang, game, pkg, b.qty || 1, b)}\n💳 ${mode === 'wallet' ? 'Wallet' : b.pm}\n📌 Status: Pending\n\n${bt(lang, 'Order Status Card ကို ဒီ Chat ထဲ ရောက်လာပါမယ်။ အောက်ကခလုတ်နဲ့လည်း ကြည့်နိုင်ပါတယ်။', 'Your live Order Status card will arrive in this chat. You can also use the button below.')}`;
  return buyShow(env, chatId, b, text, { inline_keyboard: [[styled({ text: bt(lang, 'Order Status ကြည့်မည်', 'View Order Status'), callback_data: `ord:${id}:0` }, 'primary'), { text: btn(lang, 'copyOrderId'), copy_text: { text: id } }]] });
}

// ---- callbacks ----------------------------------------------------------------------------------
async function handleBuyCallback(env, cq, ctx) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const mid = cq.message && cq.message.message_id;
  const telegramId = String(cq.from.id);
  if (!chatId || !mid) return answerCallbackQuery(env, cq.id);
  const parts = String(cq.data || '').split(':');
  const kind = parts[1];
  if (kind === 'n') return answerCallbackQuery(env, cq.id);
  // any tap leaves the live catalog; buyShowCatalog() registers it again if the tap leads back to one
  const [lang] = await Promise.all([getLanguage(env, telegramId), buyLiveClear(env, chatId)]);
  const num = (x) => parseInt(x, 10) || 0;

  // ----- browsing (stateless) -----
  if (kind === 'm') { await answerCallbackQuery(env, cq.id); await buyAbort(env, chatId, telegramId); return editTelegramMessage(env, chatId, mid, padBubble(bt(lang, '🎮 Game List\n\nဝယ်ယူလိုသော အမျိုးအစား ရွေးပါ', '🎮 Game List\n\nChoose a category')), buyCategoryMarkup(lang)); }
  if (kind === 'l') { await answerCallbackQuery(env, cq.id); const cat = parts[2]; if (!BUY_CAT_LABEL[cat]) return; return buyShowGames(env, chatId, mid, lang, cat, num(parts[3])); }
  if (kind === 'g' || kind === 'v' || kind === 's') {
    await answerCallbackQuery(env, cq.id);
    const cat = parts[2], page = num(parts[3]), gi = num(parts[4]);
    if (!BUY_CAT_LABEL[cat]) return;
    const [games, flags] = await Promise.all([buyListGames(env), buyProviderFlags(env)]);
    const group = buyGroups(games, flags, cat)[gi];
    if (!group) return buyShowGames(env, chatId, mid, lang, cat, page);
    if (kind === 's') { const gid = group.ids[num(parts[5])]; return gid ? buyEnterCatalog(env, chatId, mid, lang, telegramId, gid) : buyShowGames(env, chatId, mid, lang, cat, page); }
    if (group.ids.length > 1) return buyShowServers(env, chatId, mid, lang, cat, page, gi, kind === 'v' ? num(parts[5]) : 0, group);
    return buyEnterCatalog(env, chatId, mid, lang, telegramId, group.ids[0]);
  }
  if (kind === 'k' || kind === 'kb') {   // k = a type tab was tapped, kb = come back to the catalog from another card
    await answerCallbackQuery(env, cq.id);
    const gid = parts[2], ti = num(parts[3]);
    if (kind === 'k') {
      const sess = await getBotSession(env, telegramId);
      const cur = sess && sess.step === 'buy_pick' ? buyParse(sess) : null;
      if (cur && cur.gid === gid && cur.mid === mid && (cur.ti || 0) === ti) return;   // that tab is already open
    }
    return buyShowCatalog(env, chatId, mid, lang, telegramId, gid, ti, null);
  }
  if (kind === 'b' || kind === 'ba') {
    await answerCallbackQuery(env, cq.id);
    if (kind === 'ba') { await buyAbort(env, chatId, telegramId); return buyShowCatalog(env, chatId, mid, lang, telegramId, parts[2], 0, null); }
    if (kind === 'b') await buyAbort(env, chatId, telegramId);   // leaving the catalog: drop its price list messages
    const [games, flags] = await Promise.all([buyListGames(env), buyProviderFlags(env)]);
    const g = games.find((x) => x.id === parts[2]);
    if (!g) return editTelegramMessage(env, chatId, mid, padBubble(bt(lang, '🎮 Game List\n\nဝယ်ယူလိုသော အမျိုးအစား ရွေးပါ', '🎮 Game List\n\nChoose a category')), buyCategoryMarkup(lang));
    const cat = buyCatOf(g);
    const groups = buyGroups(games, flags, cat);
    const gi = groups.findIndex((gr) => gr.ids.includes(g.id));
    if (gi < 0) return buyShowGames(env, chatId, mid, lang, cat, 0);
    const page = Math.floor(gi / BUY_GAMES_PER_PAGE);
    if (groups[gi].ids.length > 1) return buyShowServers(env, chatId, mid, lang, cat, page, gi, Math.floor(groups[gi].ids.indexOf(g.id) / BUY_SERVERS_PER_PAGE), groups[gi]);
    return buyShowGames(env, chatId, mid, lang, cat, page);
  }

  // ----- Stop: wipes the whole flow (works at every step, browsing included) -----
  if (kind === 'x') {
    await answerCallbackQuery(env, cq.id);
    await cancelFlow(env, chatId, telegramId, [mid]);
    await fsDeleteDoc(env, `telegramBuyResume/${telegramId}`).catch(() => {});
    return sendTelegramMessage(env, chatId, padBubble(bt(lang, '⛔ ရပ်လိုက်ပါပြီ\n\nလုပ်လက်စ message တွေ အကုန်ရှင်းပြီးပါပြီ။ အစကနေ ပြန်စချင်ရင် အောက်က Game List ကို နှိပ်ပါ။', '⛔ Stopped\n\nEverything from this purchase was cleared. To start over, tap Game List below.')), { inline_keyboard: [[styled({ text: '🎮 Game List', callback_data: 'bg:m' }, 'primary')]] });
  }

  // ----- open an account inside the bot (no store login needed), then carry on with the purchase -----
  if (kind === 'rg') {
    await answerCallbackQuery(env, cq.id);
    const gid = parts[2], pi = num(parts[3]);
    const lockId = `reg${telegramId}`;
    if (!(await buyLockTake(env, lockId))) return;   // a second tap while the first one is still working
    try {
      const lim = await checkRateLimit(env, telegramId, 'bot_register', { maxCount: 5, windowMs: 60 * 60 * 1000 });
      if (lim.limited) return buyShow(env, chatId, { mid }, bt(lang, 'ခဏနေမှ ပြန်ကြိုးစားပါ။', 'Please try again a little later.'), { inline_keyboard: [[buyStop(lang)]] });
      let reg = null;
      try { reg = await botRegisterAccount(env, cq.from); }
      catch (e) { console.error('botRegisterAccount failed:', e); if (ctx) ctx.waitUntil(alertAdmin(env, `Bot register failed for ${telegramId}`, e)); }
      if (!reg || !reg.acct) {
        return buyShow(env, chatId, { mid }, `❌ ${bt(lang, 'Account မဖွင့်နိုင်သေးပါ။ ခဏနေမှ ထပ်ကြိုးစားပါ။', 'Could not create the account. Please try again shortly.')}`, { inline_keyboard: [[styled({ text: btn(lang, 'retry'), callback_data: `bg:rg:${gid}:${pi}` }, 'primary')], [buyStop(lang)]] });
      }
      const note = `${reg.created ? `✅ ${bt(lang, 'Account ဖွင့်ပြီးပါပြီ', 'Account created')}` : `✅ ${bt(lang, 'သင့် Account ကို ချိတ်ပြီးပါပြီ', 'Your account is connected')}`}\n🆔 Account ID: ${reg.acct.guestId}`;
      if (gid === '0') {
        return buyShow(env, chatId, { mid }, `${note}\n\n${bt(lang, 'Game List ကို နှိပ်ပြီး ဝယ်ယူလို့ရပါပြီ။ Wallet ဖြည့်ချင်ရင် 💼 Wallet ကို သုံးပါ။', 'You can now buy from Game List. Use 💼 Wallet to add money.')}`, { inline_keyboard: [[styled({ text: '🎮 Game List', callback_data: 'bg:m' }, 'primary')]] });
      }
      return buyStartPurchase(env, chatId, telegramId, mid, lang, gid, pi, note);
    } finally { await buyLockFree(env, lockId); }
  }

  // ----- package chosen (old price-list buttons that are still on screen keep working) -----
  if (kind === 'p') {
    await answerCallbackQuery(env, cq.id);
    return buyStartPurchase(env, chatId, telegramId, mid, lang, parts[2], num(parts[3]), '');
  }

  if (kind === 'rs') {
    await answerCallbackQuery(env, cq.id);
    const acct = await lookupAccountByTelegramId(env, telegramId);
    if (!acct) return editTelegramMessage(env, chatId, mid, t(lang, 'notConnected'), guestMarkup(lang));
    const saved = await buyReadResume(env, telegramId);
    const game = saved && await buyGetGame(env, saved.gid);
    const pkg = game && Array.isArray(game.packages) ? game.packages[saved.pi] : null;
    if (!saved || !game || !pkg) return buyShow(env, chatId, { mid }, bt(lang, 'ဆက်လုပ်စရာ မတွေ့တော့ပါ။ Game List ကနေ ပြန်စပါ။', 'Nothing to resume. Start again from Game List.'), { inline_keyboard: [[{ text: bt(lang, 'Game List', 'Game List'), callback_data: 'bg:m' }]] });
    await fsDeleteDoc(env, `telegramBuyResume/${telegramId}`).catch(() => {});
    await buyAbort(env, chatId, telegramId);
    const nb = { ...saved, mid };
    return buyShowPayChoice(env, chatId, telegramId, nb, game, pkg, lang, nb.nc === 'none');
  }

  // ----- everything below needs the session -----
  const session = await getBotSession(env, telegramId);
  const b = buyParse(session);
  if (!b || !String((session && session.step) || '').startsWith('buy_')) { await answerCallbackQuery(env, cq.id, t(lang, 'sessionGone')); return; }
  b.mid = mid;

  if (kind === 'tu') {
    await answerCallbackQuery(env, cq.id);
    try {
      await fsSetDoc(env, `telegramBuyResume/${telegramId}`, { buy: JSON.stringify({ gid: b.gid, pi: b.pi, qty: b.qty || 1, pid: b.pid || '', sid: b.sid || '', cn: b.cn || '', nm: b.nm || '', nc: b.nc || '' }), at: Date.now() });
    } catch (e) { console.error('save buy resume failed:', e); }
    await buyAbort(env, chatId, telegramId);
    await editTelegramMessage(env, chatId, mid, padBubble(bt(lang, 'Wallet ဖြည့်ပြီးတာနဲ့ "ဝယ်ယူမှု ဆက်လုပ်မည်" ခလုတ် ပေါ်လာပါမယ်။', 'Once the top-up is done, a "Continue purchase" button will appear.')), null);
    return routeTelegramMessage(env, { chat: { id: chatId }, from: cq.from, text: 'Top Up Wallet', message_id: mid, fromMenuButton: true });
  }

  const game = await buyGetGame(env, b.gid);
  const pkg = game && Array.isArray(game.packages) ? game.packages[b.pi] : null;
  if (!game || !pkg) { await answerCallbackQuery(env, cq.id); return buyShow(env, chatId, b, bt(lang, 'ဂိမ်း/Package မတွေ့တော့ပါ။ Game List ကနေ ပြန်စပါ။', 'Game/package is gone. Start again from Game List.'), null); }

  if (kind === 'q') { await answerCallbackQuery(env, cq.id); const q = num(parts[2]); if (!BUY_QTY_CHOICES.includes(q)) return; b.qty = q; return buyAfterQty(env, chatId, telegramId, b, game, pkg, lang); }
  if (kind === 'id') { await answerCallbackQuery(env, cq.id); b.pid = ''; b.sid = ''; b.cn = ''; return buyPromptId(env, chatId, telegramId, b, game, pkg, lang, ''); }
  if (kind === 'so') {
    await answerCallbackQuery(env, cq.id);
    const o = buyNeeds(game).serverOptions[num(parts[2])];
    if (!o) return;
    b.sid = o.value;
    return buyAfterIds(env, chatId, telegramId, b, game, pkg, lang);
  }
  if (kind === 'rc') { await answerCallbackQuery(env, cq.id); return buyRunNameCheck(env, chatId, telegramId, b, game, pkg, lang); }
  if (kind === 'go') { await answerCallbackQuery(env, cq.id); return buyShowPayChoice(env, chatId, telegramId, b, game, pkg, lang, false); }
  if (kind === 'bk') { await answerCallbackQuery(env, cq.id); return buyShowPayChoice(env, chatId, telegramId, b, game, pkg, lang, b.nc === 'none'); }

  if (kind === 'w') {
    await answerCallbackQuery(env, cq.id);
    const acct = await lookupAccountByTelegramId(env, telegramId);
    if (!acct) return editTelegramMessage(env, chatId, mid, t(lang, 'notConnected'), guestMarkup(lang));
    const bal = Number(acct.walletBalance) || 0;
    const total = Number(pkg.price || 0) * (b.qty || 1);
    b.pay = 'wallet';
    await buySave(env, telegramId, 'buy_pay', b);
    if (bal >= total) {
      return buyShow(env, chatId, b, `🧾 ${bt(lang, 'Order အတည်ပြုရန်', 'Confirm your order')}\n\n${buySummary(lang, game, pkg, b.qty || 1, b)}\n💼 Wallet: ${mmk(bal)} → ${mmk(bal - total)}`, {
        inline_keyboard: [[styled({ text: bt(lang, 'Confirm — ဝယ်မည်', 'Confirm — Buy'), callback_data: 'bg:cw' }, 'success')], buyBackCancel(lang, 'bg:bk')],
      });
    }
    return buyShow(env, chatId, b, `⚠️ ${bt(lang, 'Wallet လက်ကျန်ငွေ မလောက်ပါ', 'Not enough wallet balance')}\n\n${buySummary(lang, game, pkg, b.qty || 1, b)}\n💼 Wallet: ${mmk(bal)}\n➕ ${bt(lang, 'လိုသေးငွေ', 'Short by')}: ${mmk(total - bal)}\n\n${bt(lang, 'Wallet ဖြည့်မလား၊ Payment သုံးမလား?', 'Top up the wallet or pay with a Payment method?')}`, {
      inline_keyboard: [[styled({ text: bt(lang, 'Wallet ဖြည့်မည်', 'Top up wallet'), callback_data: 'bg:tu' }, 'success'), styled({ text: 'Payment', callback_data: 'bg:pay' }, 'primary')], buyBackCancel(lang, 'bg:bk')],
    });
  }
  if (kind === 'pay') {
    await answerCallbackQuery(env, cq.id);
    const methods = await listPaymentMethods(env);
    if (!methods.length) return buyShow(env, chatId, b, t(lang, 'noMethods'), openAppInlineKeyboard());
    b.pay = 'bank'; b.rf = '';
    await buySave(env, telegramId, 'buy_pay', b);
    const total = Number(pkg.price || 0) * (b.qty || 1);
    const notes = methods.filter((m) => m.availabilityNote).map((m) => `${m.name}: ${m.availabilityNote}`);
    const btns = methods.map((m, i) => ({ text: m.name, callback_data: `bg:pm:${i}` }));
    return buyShow(env, chatId, b, `💳 ${bt(lang, 'Payment နည်းလမ်း ရွေးပါ', 'Choose a payment method')}\n💰 ${mmk(total)}${notes.length ? `\n\n${notes.join('\n')}` : ''}`, { inline_keyboard: [...buyGrid(btns, 2), buyBackCancel(lang, 'bg:bk')] });
  }
  if (kind === 'pm' || kind === 'rp') {
    await answerCallbackQuery(env, cq.id);
    if (kind === 'pm') {
      const m = (await listPaymentMethods(env))[num(parts[2])];
      if (!m) return;
      b.pm = m.name; b.pmn = m.number || ''; b.pma = m.accountName || '';
      await setLastPaymentMethod(env, telegramId, m.id, m.name);
    }
    b.rf = ''; b.pay = 'bank';
    await buySave(env, telegramId, 'buy_receipt', b);
    const total = Number(pkg.price || 0) * (b.qty || 1);
    const copyRow = [];
    if (b.pmn) copyRow.push({ text: btn(lang, 'copyNumber'), copy_text: { text: String(b.pmn).trim().slice(0, 256) } });
    copyRow.push({ text: btn(lang, 'copyAmount'), copy_text: { text: String(Math.round(total)) } });
    return buyShow(env, chatId, b, `💳 ${b.pm}\n${b.pmn ? `📞 ${b.pmn}\n` : ''}${b.pma ? `👤 ${b.pma}\n` : ''}💰 ${mmk(total)}\n\n${bt(lang, 'ဒီ Account ကို ငွေလွဲပြီး Screenshot ပုံကို ဒီ Chat မှာ ပို့ပါ', 'Transfer to this account, then send the screenshot here')}`, {
      inline_keyboard: [copyRow, [{ text: bt(lang, 'Payment ပြောင်း', 'Change method'), callback_data: 'bg:pay' }, buyStop(lang)]],
    });
  }
  if (kind === 'cw') return buyPlaceOrder(env, ctx, cq, b, 'wallet', lang);
  if (kind === 'cr') {
    if (!b.rf || b.pay !== 'bank' || !b.pm) { await answerCallbackQuery(env, cq.id, bt(lang, 'ပုံ အရင်ပို့ပါ', 'Send the receipt photo first'), true); return; }
    return buyPlaceOrder(env, ctx, cq, b, 'bank', lang);
  }
  return answerCallbackQuery(env, cq.id);
}
