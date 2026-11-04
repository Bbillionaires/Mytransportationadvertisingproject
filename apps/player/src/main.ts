import { ApiError, Device } from './device';
import { flush, record } from './events';
import { Exposure } from './exposure';
import { qrSvg } from './qr';
import { playableUrl, prefetch, prune } from './mediacache';
import { kvGet, kvSet } from './store';
import { $, button, closeOverlay, el, hideToast, onOverlayClose, openOverlay, overlayOpen, sleep, toast } from './ui';

// Shorter intervals only for local development/e2e (never honoured on a real host).
const FAST = new URLSearchParams(location.search).has('fast') && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const T = FAST
  ? { heartbeat: 2_000, flush: 2_000, playlistRetry: 2_000, active: 15_000, proximity: 3_000, banner: 4_000, display: 3_000, pairPoll: 1_000 }
  : { heartbeat: 60_000, flush: 20_000, playlistRetry: 30_000, active: 300_000, proximity: 60_000, banner: 15_000, display: 8_000, pairPoll: 2_000 };

interface Media { url: string; cacheKey?: string; expiresAt: string }
interface Ad { campaignId: string; creativeId: string; kind: 'VIDEO' | 'BANNER' | 'DISPLAY'; durationMs: number | null; headline: string | null; bodyText: string | null;
  destinationUrl: string | null; clickIdParam: string; coupon: { description: string } | null; priority: number; frequencyCapPerHour: number | null; skipDelaySeconds: number; expiresAt: string; media: Media | null }
interface Content { videoId: string; creatorId: string; channelName: string; title: string; durationMs: number; media: Media }
interface Playlist { playbackAllowed: boolean; reason?: string; deviceStatus: string; validUntil: string; ads: Ad[]; content: Content[] }

const state = {
  device: null as Device | null,
  playlist: null as Playlist | null,
  suspended: false,
  rider: null as null | { name: string; session: string; expiresAt: number },
  abort: new AbortController(),          // aborts the current item (suspend, refresh)
  contentIdx: 0, adIdx: 0, bannerIdx: 0,
  lastContent: null as Content | null,
  plays: new Map<string, number[]>(),    // campaignId -> play timestamps (local frequency cap)
  interactions: 0, segmentStart: new Date(),
  position: null as null | { latitude: number; longitude: number; speedMps?: number },
  playbackState: 'IDLE' as 'PLAYING' | 'IDLE' | 'SUSPENDED' | 'ERROR',
};

const video = () => $<HTMLVideoElement>('#video');
const riderHeaders = (): Record<string, string> => (state.rider && state.rider.expiresAt > Date.now() ? { 'x-rider-session': state.rider.session } : {});
const live = (a: Ad) => new Date(a.expiresAt).getTime() > Date.now() && (!a.media || new Date(a.media.expiresAt).getTime() > Date.now());

// ---------------------------------------------------------------- setup / enrollment
async function setup(): Promise<Device> {
  const existing = await Device.load();
  if (existing) return existing;
  const s = $('#setup');
  s.hidden = false;
  return new Promise((resolve) => {
    $<HTMLFormElement>('#setup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('#setup-msg');
      msg.textContent = 'Enrolling…';
      try {
        const d = await Device.enroll($<HTMLInputElement>('#code').value);
        s.hidden = true;
        resolve(d);
      } catch (err) { msg.textContent = err instanceof ApiError ? err.message : 'Could not reach the server.'; }
    });
  });
}

// ---------------------------------------------------------------- playlist
async function refreshPlaylist() {
  try {
    state.playlist = await state.device!.call<Playlist>('GET', '/v1/devices/playlist');
    await kvSet('lastPlaylist', state.playlist);
    void syncMediaCache(state.playlist);
  } catch (e) {
    if (!state.playlist) state.playlist = (await kvGet<Playlist>('lastPlaylist')) ?? null; // offline: keep last known (expired items are skipped)
  }
}
/**
 * Keep the tablet's media cache in step with a fresh playlist: drop what the server no longer lists, then download
 * what is missing (ads first), one at a time in the background. See mediacache.ts (R-029).
 */
let cacheSync: AbortController | null = null;
let cacheChain: Promise<unknown> = Promise.resolve();
function syncMediaCache(p: Playlist) {
  // Syncs run one at a time; a newer playlist cancels the older download first, so a download that started under
  // an old playlist can never re-add media after the newer playlist removed it.
  cacheSync?.abort();
  const ctl = (cacheSync = new AbortController());
  cacheChain = cacheChain.then(async () => {
    if (ctl.signal.aborted) return;
    const media = [...p.ads.map((a) => a.media), ...p.content.map((c) => c.media)].filter((m): m is Media => !!m);
    await prune(new Set(media.map((m) => m.cacheKey).filter((k): k is string => !!k))).catch(() => 0);
    if (p.playbackAllowed) await prefetch(media, ctl.signal).catch(() => 0);
  });
  return cacheChain;
}

async function playlistLoop() {
  for (;;) {
    await refreshPlaylist();
    const until = state.playlist?.validUntil ? new Date(state.playlist.validUntil).getTime() - Date.now() - 30_000 : 0;
    await sleep(state.playlist?.playbackAllowed ? Math.max(T.playlistRetry, until) : T.playlistRetry);
  }
}

function pickAd(kind: (k: Ad['kind']) => boolean): Ad | null {
  const ads = (state.playlist?.ads ?? []).filter((a) => kind(a.kind) && live(a) && (a.kind === 'BANNER' || a.media));
  const hourAgo = Date.now() - 3_600_000;
  const ok = ads.filter((a) => !a.frequencyCapPerHour || (state.plays.get(a.campaignId) ?? []).filter((t) => t > hourAgo).length < a.frequencyCapPerHour);
  if (!ok.length) return null;
  ok.sort((x, y) => y.priority - x.priority);
  const top = ok.filter((a) => a.priority === ok[0]!.priority);
  return top[state.adIdx++ % top.length]!;
}
const notePlay = (a: Ad) => state.plays.set(a.campaignId, [...(state.plays.get(a.campaignId) ?? []).filter((t) => t > Date.now() - 3_600_000), Date.now()]);

// ---------------------------------------------------------------- playback
function playMedia(url: string, signal: AbortSignal, exposure: Exposure, onTime?: (t: number) => void): Promise<{ completed: boolean }> {
  const v = video();
  return new Promise((resolve) => {
    let done = false;
    const finish = (completed: boolean) => {
      if (done) return; done = true;
      for (const [ev, fn] of handlers) v.removeEventListener(ev, fn);
      v.pause(); exposure.set(false);
      resolve({ completed });
    };
    const handlers: Array<[string, () => void]> = [
      ['playing', () => exposure.set(true)], ['pause', () => exposure.set(false)], ['waiting', () => exposure.set(false)],
      ['ended', () => finish(true)], ['error', () => finish(false)], ['timeupdate', () => onTime?.(v.currentTime)],
    ];
    for (const [ev, fn] of handlers) v.addEventListener(ev, fn);
    signal.addEventListener('abort', () => finish(false));
    v.hidden = false;
    v.src = url;
    v.muted = false;
    v.play().catch(() => {
      // Autoplay with sound blocked (plain browser): ask for one tap. Kiosk shells allow it without a gesture.
      const tap = $('#tap');
      tap.hidden = false;
      tap.onclick = () => { tap.hidden = true; v.play().catch(() => finish(false)); };
    });
  });
}

async function playContent(c: Content, signal: AbortSignal) {
  state.lastContent = c;
  $('#now').textContent = `${c.title} · ${c.channelName}`;
  const next = $('#next');
  next.hidden = false;
  const local = new AbortController();
  next.onclick = () => { state.interactions++; local.abort(); };
  signal.addEventListener('abort', () => local.abort());
  const ex = new Exposure(video());
  state.playbackState = 'PLAYING';
  const bannerStop = new AbortController();
  void bannerLoop(bannerStop.signal);
  const { completed } = await playMedia(await playableUrl(c.media), local.signal, ex);
  bannerStop.abort();
  next.hidden = true;
  await record({ type: 'CONTENT_PLAYBACK', videoId: c.videoId, completed, ...ex.finish() });
}

function adControls(ad: Ad, pauseFor: (fn: () => Promise<void>) => void) {
  const ui = $('#adui');
  const learn = ad.destinationUrl ? button('Learn more', () => pauseFor(() => openLanding(ad)), 'btn') : null;
  const coupon = ad.coupon ? button(ad.coupon.description || 'Get coupon', () => pauseFor(() => claimCoupon(ad)), 'btn primary') : null;
  const skip = el('button', { type: 'button', class: 'btn skip', disabled: '' }, `Skip in ${ad.skipDelaySeconds}`);
  ui.replaceChildren(...[el('span', { class: 'adlabel' }, 'Ad'), el('span', { class: 'headline' }, ad.headline ?? ''), learn, coupon, skip].filter((x): x is HTMLElement => !!x));
  ui.hidden = false;
  return skip;
}

async function playVideoAd(ad: Ad, signal: AbortSignal) {
  const local = new AbortController();
  signal.addEventListener('abort', () => local.abort());
  let skipped = false;
  const ex = new Exposure(video());
  const v = video();
  const pauseFor = (fn: () => Promise<void>) => { state.interactions++; v.pause(); onOverlayClose(() => { void v.play(); }); void fn(); };
  $('#now').textContent = 'Advertisement';
  const skip = adControls(ad, pauseFor);
  skip.onclick = () => { state.interactions++; skipped = true; local.abort(); };
  const { completed } = await playMedia(await playableUrl(ad.media!), local.signal, ex, (t) => {
    const left = Math.ceil(ad.skipDelaySeconds - t);
    if (left > 0) skip.textContent = `Skip in ${left}`; else { skip.textContent = 'Skip ad'; skip.removeAttribute('disabled'); }
  });
  $('#adui').hidden = true;
  notePlay(ad);
  await record({ type: 'AD_PLAYBACK', campaignId: ad.campaignId, creativeId: ad.creativeId, contentVideoId: state.lastContent?.videoId, completed: completed && !skipped, skipped, ...ex.finish() });
}

async function showDisplayAd(ad: Ad, signal: AbortSignal) {
  const img = $<HTMLImageElement>('#display');
  img.src = await playableUrl(ad.media!); img.alt = ad.headline ?? 'Advertisement'; img.hidden = false; video().hidden = true;
  $('#now').textContent = 'Advertisement';
  const ex = new Exposure(null);
  ex.set(true);
  adControls(ad, (fn) => { ex.set(false); onOverlayClose(() => ex.set(true)); void fn(); }).hidden = true;
  await sleep(T.display, signal);
  img.hidden = true; $('#adui').hidden = true;
  notePlay(ad);
  await record({ type: 'AD_PLAYBACK', campaignId: ad.campaignId, creativeId: ad.creativeId, contentVideoId: state.lastContent?.videoId, completed: true, skipped: false, ...ex.finish() });
}

/** Word/text banners rotate over content (they don't overlap video ads, so playback overlap checks are unaffected). */
async function bannerLoop(signal: AbortSignal) {
  while (!signal.aborted) {
    const ad = pickAd((k) => k === 'BANNER');
    if (!ad) return;
    const b = $('#banner');
    const tap = ad.coupon ? () => { state.interactions++; void claimCoupon(ad); } : ad.destinationUrl ? () => { state.interactions++; void openLanding(ad); } : null;
    b.replaceChildren(...[el('span', { class: 'adlabel' }, 'Sponsored'), el('strong', {}, ad.headline ?? ''), ad.bodyText ? el('span', {}, ad.bodyText) : null,
      tap ? button(ad.coupon ? 'Get coupon' : 'Learn more', tap, 'btn small') : null].filter((x): x is HTMLElement => !!x));
    b.hidden = false;
    const ex = new Exposure(null);
    ex.set(true);
    await sleep(T.banner, signal);
    b.hidden = true;
    notePlay(ad);
    await record({ type: 'AD_PLAYBACK', campaignId: ad.campaignId, creativeId: ad.creativeId, contentVideoId: state.lastContent?.videoId, completed: true, skipped: false, ...ex.finish() });
  }
}

function idle(message: string) {
  video().hidden = true;
  $('#now').textContent = '';
  const i = $('#idle');
  i.textContent = message;
  i.hidden = false;
}

async function playbackLoop() {
  for (;;) {
    const pl = state.playlist;
    const signal = state.abort.signal;
    if (state.suspended || !pl?.playbackAllowed) {
      state.playbackState = state.suspended ? 'SUSPENDED' : 'IDLE';
      idle(state.suspended ? 'Screen paused by the fleet operator.' : pl?.reason === 'NOT_ASSIGNED_TO_VEHICLE' ? 'Waiting for vehicle assignment…' : 'Enjoy your ride.');
      await sleep(1000);
      continue;
    }
    $('#idle').hidden = true;
    const content = pl.content.filter((c) => new Date(c.media.expiresAt).getTime() > Date.now());
    let played = false;
    if (content.length) { await playContent(content[state.contentIdx++ % content.length]!, signal); played = true; }
    if (signal.aborted) { await sleep(200); continue; }
    const ad = pickAd((k) => k === 'VIDEO' || k === 'DISPLAY');
    if (ad) { await (ad.kind === 'VIDEO' ? playVideoAd(ad, signal) : showDisplayAd(ad, signal)); played = true; }
    if (!played) { idle('Enjoy your ride.'); await sleep(3000); }
  }
}

// ---------------------------------------------------------------- landing pages and coupons
/** Default: QR code to open on the passenger's own phone. Optional: a sandboxed in-tablet view with an always-visible way back. */
async function openLanding(ad: Ad) {
  const eventId = crypto.randomUUID();
  await record({ type: 'CLICK', eventId, campaignId: ad.campaignId, creativeId: ad.creativeId, contentVideoId: state.lastContent?.videoId, target: 'LANDING_PAGE', occurredAt: new Date().toISOString() });
  const url = new URL(ad.destinationUrl!);
  url.searchParams.set(ad.clickIdParam || 'rmn_click', eventId);
  const frameBox = el('div', { class: 'framebox' });
  openOverlay(ad.headline ?? 'Learn more', qrSvg(url.toString(), 'QR code to open the offer on your phone'), el('p', {}, 'Scan with your phone camera to open this offer on your own device.'),
    button('Open on this screen', () => {
      frameBox.replaceChildren(el('iframe', { src: url.toString(), sandbox: 'allow-scripts allow-forms allow-same-origin allow-popups', referrerpolicy: 'no-referrer', title: 'Advertiser page' }));
    }, 'btn'), frameBox);
}

async function claimCoupon(ad: Ad) {
  try {
    const c = await state.device!.call('POST', '/v1/devices/coupons', { campaignId: ad.campaignId, creativeId: ad.creativeId, contentVideoId: state.lastContent?.videoId }, riderHeaders());
    openOverlay(c.description ?? 'Your coupon', qrSvg(c.qrPayload, 'Coupon QR code'), el('p', { class: 'code', id: 'coupon-code' }, c.code),
      el('p', {}, c.savedToWallet ? 'Saved to your rider wallet.' : `Show this code at checkout. Valid until ${new Date(c.expiresAt).toLocaleDateString()}.`));
  } catch (e) {
    openOverlay('Coupon', el('p', {}, e instanceof ApiError ? e.message : 'Coupons are unavailable offline.'));
  }
}

// ---------------------------------------------------------------- rider sign-in (QR)
function renderRider() {
  const r = state.rider && state.rider.expiresAt > Date.now() ? state.rider : null;
  if (!r) state.rider = null;
  $('#rider').replaceChildren(r
    ? el('span', { class: 'hi', id: 'rider-name' }, `Hi ${r.name}`)
    : button('Sign in for rewards', () => { state.interactions++; void signIn(); }, 'btn small', 'Sign in with your phone to save coupons and rewards'),
  r ? button('Sign out', () => { void signOut(); }, 'btn small') : '');
}
async function signIn() {
  const p = await state.device!.call('POST', '/v1/devices/rider-pairings', {});
  let open = true;
  onOverlayClose(() => { open = false; });
  openOverlay('Sign in with your phone', qrSvg(p.qrPayload, 'Sign-in QR code'), el('p', {}, "Point your phone's camera at the code to sign in, or enter this code in the rider app:"), el('p', { class: 'code', id: 'pair-code' }, p.code));
  const until = new Date(p.expiresAt).getTime();
  while (open && Date.now() < until) {
    await sleep(T.pairPoll);
    const s = await state.device!.call('GET', `/v1/devices/rider-pairings/${p.pairingId}`).catch(() => null);
    if (s?.status === 'PAIRED' && s.riderSession) {
      state.rider = { name: s.riderDisplayName, session: s.riderSession, expiresAt: new Date(s.expiresAt).getTime() }; // memory only, never persisted
      renderRider(); closeOverlay(); return;
    }
  }
  if (open) closeOverlay();
}
async function signOut() {
  const h = riderHeaders();
  state.rider = null;
  renderRider();
  closeOverlay();
  await state.device!.call('POST', '/v1/devices/rider-sessions/end', {}, h).catch(() => {});
}

// ---------------------------------------------------------------- games
async function openGames() {
  state.interactions++;
  const g = await state.device!.call('GET', '/v1/devices/games');
  openOverlay('Games', el('p', { class: 'muted' }, g.rules),
    el('div', { class: 'grid' }, ...g.games.filter((x: any) => x.kind === 'TRIVIA' || x.kind === 'MEMORY').map((x: any) => button(x.name, () => void startGame(x.slug, x.kind), 'btn tile'))),
    g.sponsoredRewards.length ? el('p', {}, `Rewards today: ${g.sponsoredRewards.map((r: any) => `${r.reward_description} from ${r.sponsor}`).join('; ')}`) : null);
}
async function startGame(slug: string, kind: string) {
  const s = await state.device!.call('POST', `/v1/devices/games/${slug}/sessions`, {}, riderHeaders());
  const finish = async (body: object) => {
    const r = await state.device!.call('POST', `/v1/devices/games/sessions/${s.sessionId}/complete`, body, riderHeaders());
    openOverlay('Result', el('p', { id: 'game-result' }, r.verdict === 'ACCEPTED' ? `Score: ${r.score}` : 'That was too quick to count. Try again!'),
      r.reward ? el('p', { class: 'reward', id: 'game-reward' }, `You won: ${r.reward.description} — code ${r.reward.code}`) : null,
      !state.rider ? el('p', { class: 'muted' }, 'Sign in to earn sponsor rewards.') : null);
  };
  if (kind === 'TRIVIA') {
    const answers: number[] = [];
    const qs = s.questions as Array<{ index: number; q: string; options: string[] }>;
    const form = el('form', { id: 'trivia' }, ...qs.map((q) => el('fieldset', {}, el('legend', {}, q.q),
      ...q.options.map((o, i) => el('label', {}, Object.assign(el('input', { type: 'radio', name: `q${q.index}`, value: String(i), required: '' }), {}), ` ${o}`)))),
      el('button', { type: 'submit', class: 'btn primary' }, 'Submit answers'));
    form.addEventListener('submit', (e) => { e.preventDefault(); state.interactions++; for (const q of qs) answers.push(Number((form.querySelector(`input[name=q${q.index}]:checked`) as HTMLInputElement).value)); void finish({ answers }); });
    openOverlay('City Trivia', form);
  } else {
    const symbols = ['☀', '☂', '★', '♫'];
    const deck = [...symbols, ...symbols].sort(() => Math.random() - 0.5);
    let open: HTMLButtonElement[] = [], matched = 0, moves = 0;
    const cards = deck.map((sym) => {
      const c = el('button', { type: 'button', class: 'card', 'aria-label': 'Hidden card' }, '?') as HTMLButtonElement;
      c.onclick = () => {
        if (open.length === 2 || c.classList.contains('done') || open.includes(c)) return;
        state.interactions++;
        c.textContent = sym; c.setAttribute('aria-label', sym); open.push(c);
        if (open.length === 2) {
          moves++;
          const [a, b] = open;
          if (a!.textContent === b!.textContent) { a!.classList.add('done'); b!.classList.add('done'); open = []; matched++; if (matched === symbols.length) void finish({ score: Math.max(100, 1000 - 50 * (moves - symbols.length)) }); }
          else setTimeout(() => { for (const x of open) { x.textContent = '?'; x.setAttribute('aria-label', 'Hidden card'); } open = []; }, 700);
        }
      };
      return c;
    });
    openOverlay('Memory Match', el('div', { class: 'cards', id: 'memory' }, ...cards));
  }
}

// ---------------------------------------------------------------- proximity alerts (silent, passenger-only, 60 s)
function watchLocation() {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.watchPosition((p) => {
    state.position = { latitude: p.coords.latitude, longitude: p.coords.longitude, ...(p.coords.speed !== null ? { speedMps: p.coords.speed } : {}) };
  }, () => {}, { enableHighAccuracy: false, maximumAge: 30_000 });
}
async function proximityLoop() {
  for (;;) {
    await sleep(T.proximity);
    if (!state.position || state.suspended || overlayOpen()) continue;
    const r = await state.device!.call('POST', '/v1/devices/proximity', state.position).catch(() => null);
    const a = r?.alert;
    if (!a) continue;
    const outcome = (o: string) => state.device!.call('POST', `/v1/devices/proximity/alerts/${a.alertId}/outcome`, { outcome: o }).catch(() => {});
    void outcome('SHOWN');
    const ad = (state.playlist?.ads ?? []).find((x) => x.campaignId === a.campaignId);
    let settled = false;
    const done = (o: string) => { if (settled) return; settled = true; hideToast(); void outcome(o); };
    toast(el('div', { class: 'toast-body', id: 'proximity-alert' }, el('strong', {}, a.title), el('span', {}, a.message), el('em', {}, a.context)),
      a.coupon && ad ? button(a.coupon.description, () => { state.interactions++; done('CLAIMED'); void claimCoupon(ad); }, 'btn small primary') : button('Open', () => { state.interactions++; done('OPENED'); }, 'btn small'),
      button('Dismiss', () => done('DISMISSED'), 'btn small'));
    setTimeout(() => done('EXPIRED'), Math.max(0, new Date(a.expiresAt).getTime() - Date.now()));
  }
}

// ---------------------------------------------------------------- heartbeat, commands, active time, upload
async function handleCommand(c: { id: string; command: string }) {
  if (c.command === 'SUSPEND') { state.suspended = true; state.abort.abort(); state.abort = new AbortController(); closeOverlay(); }
  if (c.command === 'RESUME') state.suspended = false;
  if (c.command === 'REFRESH_PLAYBACK') { await refreshPlaylist(); state.abort.abort(); state.abort = new AbortController(); }
  if (c.command === 'PURGE_RIDER_DATA') { state.rider = null; renderRider(); closeOverlay(); hideToast(); }
  await state.device!.call('POST', `/v1/devices/commands/${c.id}/ack`, { ok: true }).catch(() => {});
}
async function heartbeatLoop() {
  for (;;) {
    try {
      const storage = (await navigator.storage?.estimate?.().catch(() => null)) ?? null;
      const r = await state.device!.call('POST', '/v1/devices/heartbeat', {
        appVersion: state.device!.appVersion, connectivity: navigator.onLine ? 'UNKNOWN' : 'OFFLINE_RECOVERED',
        ...(storage?.quota && storage.usage !== undefined ? { storageFreeBytes: Math.max(0, Math.floor(storage.quota - storage.usage)) } : {}),
        playback: { state: state.playbackState },
      });
      const wasSuspended = state.suspended;
      state.suspended = r.deviceStatus !== 'ACTIVE';
      if (state.suspended && !wasSuspended) { state.abort.abort(); state.abort = new AbortController(); }
      for (const c of r.commands) await handleCommand(c);
      $('#status').textContent = '';
    } catch { $('#status').textContent = 'Offline — playback continues'; }
    renderRider();
    await sleep(T.heartbeat);
  }
}
async function activeLoop() {
  for (;;) {
    await sleep(T.active);
    const end = new Date();
    await record({ type: 'ACTIVE_SEGMENT', startedAt: state.segmentStart.toISOString(), endedAt: end.toISOString(), screenOn: document.visibilityState === 'visible', interactions: state.interactions });
    state.segmentStart = end; state.interactions = 0;
  }
}
async function flushLoop() {
  for (;;) { await flush(state.device!); await sleep(T.flush); }
}

// ---------------------------------------------------------------- boot
async function boot() {
  if (!crypto.subtle) { $('#idle').textContent = 'This player needs a secure (https) connection.'; return; }
  state.device = await setup();
  $('#serial').textContent = state.device.serial;
  $('#games').addEventListener('click', () => void openGames());
  document.addEventListener('pointerdown', () => { state.interactions++; }, { passive: true });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlay(); });
  window.addEventListener('online', () => void flush(state.device!));
  await (navigator as any).wakeLock?.request?.('screen').catch(() => {});
  renderRider();
  watchLocation();
  void heartbeatLoop(); void playlistLoop(); void flushLoop(); void activeLoop(); void proximityLoop();
  await sleep(300);
  void playbackLoop();
}
void boot();
