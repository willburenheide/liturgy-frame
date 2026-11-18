// liturgy-frame: a small Cloudflare Worker that answers two questions for a home screen.
//
//   GET /api/liturgy?date=YYYY-MM-DD
//       The day on the Roman Calendar (your national calendar): every celebration, highest rank
//       first, with rank, liturgical colour, season, psalter week and Holy Day of Obligation,
//       plus the Rosary mysteries and lectionary cycles from liturgy.day.
//
//   GET /api/daily?date=YYYY-MM-DD
//       The day's reading: the saint (when the calendar has a memorial, feast or optional
//       memorial of a saint) from Franciscan Media, or Vatican News when Franciscan Media writes
//       about someone else that day; and the day's Gospel with Bishop Barron's reflection from
//       Word on Fire. Either can be null.
//
// Everything else is served from ./web (the card and a demo page).
//
// Settings (wrangler.jsonc "vars"):
//   CALENDAR   which national calendar, as the Liturgical Calendar API names it: "nation/US"
//              (default), "nation/CA", "nation/IT", ... or "" for the General Roman Calendar.
//   TIMEZONE   used only by the scheduled warm-up, so tomorrow's reading is ready at midnight.
// Optional:
//   ACCESS_KEY (secret) when set, requests need it as the X-Liturgy-Key header or ?key=.
//              Not needed: everything here is public. Set it if you don't want others using
//              your Worker's quota.
//   KV binding LITURGY_KV keeps the year's calendar and the day's reading between restarts, so
//              the sources are asked less often. Works without it (memory only).
//
// The text itself is never stored in this repository: it is fetched from the publishers each
// day and shown with their name. Please keep the credit lines.

const UA = { 'user-agent': 'liturgy-frame (+https://github.com/willburenheide/liturgy-frame)' };
let memo = {};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: 'not found' }, 404);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    if (env.ACCESS_KEY) {
      const given = request.headers.get('X-Liturgy-Key') || url.searchParams.get('key') || '';
      if (!keyOk(given, env.ACCESS_KEY)) return json({ error: 'unauthorized' }, 401);
    }
    try {
      const date = pickDate(url.searchParams.get('date'));
      if (url.pathname === '/api/liturgy') return json(await liturgy(env, date));
      if (url.pathname === '/api/daily') return json(await shared(env, 'daily:' + date, 6 * 3600e3, () => daily(env, date)));
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502);
    }
    return json({ error: 'not found' }, 404);
  },

  // Optional (wrangler.jsonc "triggers"): fetch today's reading ahead of time, and tomorrow's
  // after 11 PM, so the first tap of the day is instant.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const tz = env.TIMEZONE || 'America/New_York';
      const days = [localDate(tz, 0)];
      if (localHour(tz) >= 23) days.push(localDate(tz, 1));
      for (const d of days) { try { await refresh(env, 'daily:' + d, () => daily(env, d)); } catch (e) {} }
    })());
  }
};

// ------------------------------------------------------------------ helpers
function cors() {
  return { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'X-Liturgy-Key', 'access-control-allow-methods': 'GET, OPTIONS' };
}
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, cors())
  });
}
function keyOk(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
// The screen sends its own local date. Only a few days around today are accepted, so stray dates
// can't make the Worker fetch other years or grow its caches.
function pickDate(s) {
  const today = new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return today;
  return Math.abs(Date.parse(s + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) <= 3 * 864e5 ? s : today;
}
function localDate(tz, plusDays) {
  const t = Date.now() + (plusDays || 0) * 864e5;
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t); }
  catch (e) { return new Date(t).toISOString().slice(0, 10); }
}
function localHour(tz) {
  try { return +new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(Date.now()); }
  catch (e) { return new Date().getUTCHours(); }
}

// Results are shared between requests, but in-flight work is not: on Workers, a request that
// awaits a promise started by another request can hang if that request ends first.
async function cached(name, ttl, fn) {
  const m = memo[name];
  if (m && Date.now() - m.at < ttl) return m.value;
  const value = await fn();
  memo[name] = { at: Date.now(), value };
  return value;
}
async function kvGet(env, k) {
  if (!env.LITURGY_KV) return null;
  try { return JSON.parse((await env.LITURGY_KV.get(k)) || 'null'); } catch (e) { return null; }
}
async function kvPut(env, k, v, opts) {
  if (!env.LITURGY_KV) return;
  try { await env.LITURGY_KV.put(k, JSON.stringify(v), opts); } catch (e) {}   // a full quota mustn't lose the answer
}
// Memory first, then KV, then the sources. If the sources fail, an older saved copy is served.
async function shared(env, name, maxAge, fn) {
  const m = memo['kv:' + name];
  if (m && Date.now() - m.at < 60e3) return m.value;
  const stored = await kvGet(env, name);
  if (stored && Date.now() - stored.at < maxAge) { memo['kv:' + name] = { at: Date.now(), value: stored.value }; return stored.value; }
  try { return await cached('fresh:' + name, 60e3, () => refresh(env, name, fn)); }
  catch (e) { if (stored) return stored.value; throw e; }
}
async function refresh(env, name, fn) {
  const value = await fn();
  memo['kv:' + name] = { at: Date.now(), value };
  if (!(value.saint || value.gospel)) return value;          // not published yet: don't keep "nothing"
  await kvPut(env, name, { at: Date.now(), value }, { expirationTtl: 3 * 86400 });
  return value;
}

function decode(t) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
  return t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n ? String.fromCodePoint(n) : ''; }
    return named[e.toLowerCase()] ?? m;
  });
}
const tagText = (h, br) => decode(h.replace(/<br\s*\/?>/gi, br || ' ').replace(/<\/li>\s*<li[^>]*>/gi, br || ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ------------------------------------------------------------------ the liturgical day
// Liturgical Calendar API (https://litcal.johnromanodorazio.com, open source): the General Roman
// Calendar with a national calendar, one civil year per request (~450 KB). The year is condensed
// to a small day-by-day map, kept in memory and KV for 30 days. Vigil Masses are left out.
const LITCAL = 'https://litcal.johnromanodorazio.com/api/v5/calendar/';
const RANKS = { 7: 'Solemnity', 6: 'Solemnity', 5: 'Feast of the Lord', 4: 'Feast', 3: 'Memorial', 2: 'Optional memorial', 1: 'Commemoration', 0: 'Weekday' };
function calendarPath(env) {
  const c = env.CALENDAR == null ? 'nation/US' : String(env.CALENDAR).replace(/^\/+|\/+$/g, '');
  return /^(nation|diocese)\/[A-Za-z0-9_-]+$/.test(c) ? c + '/' : '';
}
function isUS(env) { return calendarPath(env) === 'nation/US/'; }

function litcalYear(env, year) {
  return cached('litcal:' + calendarPath(env) + year, 864e5, () => loadLitcalYear(env, year));
}
async function loadLitcalYear(env, year) {
  const k = 'litcal:' + calendarPath(env) + year;
  const stored = await kvGet(env, k);
  if (stored && Date.now() - stored.at < 30 * 864e5) return stored.map;
  let map;
  try {
    const res = await fetch(LITCAL + calendarPath(env) + year + '?year_type=CIVIL', { headers: Object.assign({ accept: 'application/json' }, UA) });
    if (!res.ok) throw new Error('liturgical calendar HTTP ' + res.status);
    const body = await res.json();
    map = {};
    for (const e of body.litcal || []) {
      if (e.is_vigil_mass || e.year !== year) continue;
      const d = year + '-' + String(e.month).padStart(2, '0') + '-' + String(e.day).padStart(2, '0');
      (map[d] = map[d] || []).push({
        name: String(e.name || ''), grade: +e.grade || 0,
        rank: e.day_of_the_week_iso8601 === 7 && /sunday/i.test(e.name || '') ? 'Sunday' : (RANKS[+e.grade] || ''),
        color: Array.isArray(e.color) ? e.color : [], season: String(e.liturgical_season_lcl || ''),
        psalter: +e.psalter_week || 0, obligation: !!e.holy_day_of_obligation
      });
    }
    for (const d in map) map[d].sort((a, b) => b.grade - a.grade);
  } catch (e) {
    if (!stored) throw e;
    return stored.map;                                     // API down: keep the copy we have
  }
  await kvPut(env, k, { at: Date.now(), map });
  return map;
}

async function liturgy(env, date) {
  const map = await litcalYear(env, +date.slice(0, 4));
  const celebrations = (map[date] || []).map(c => Object.assign({}, c, { obligation: isUS(env) ? usObligation(c, date) : c.obligation }));
  return { date, celebrations, extra: await liturgyDay(date) };
}
// In the United States, when Mary, Mother of God (Jan 1), the Assumption (Aug 15) or All Saints
// (Nov 1) falls on a Saturday or a Monday, the obligation to attend Mass is lifted (USCCB, 1991).
// The Liturgical Calendar API marks them obligatory every year.
function usObligation(c, date) {
  if (!c.obligation) return false;
  const dow = new Date(date + 'T12:00:00Z').getUTCDay();
  return !(['01-01', '08-15', '11-01'].includes(date.slice(5)) && (dow === 6 || dow === 1));
}
// Rosary mysteries and lectionary cycles for the day (https://liturgy.day, open source).
async function liturgyDay(date) {
  return cached('lday:' + date, 6 * 3600e3, async () => {
    try {
      const res = await fetch('https://liturgy.day/api/day/' + date, { headers: UA });
      if (!res.ok) return null;
      const d = await res.json();
      return { rosary: d['rosary-series'] || '', sundayCycle: d['sunday-cycle'] || '', weekdayCycle: d['weekday-cycle'] || '' };
    } catch (e) { return null; }
  });
}

// ------------------------------------------------------------------ Saint of the Day: Franciscan Media
// The publisher's own feed (last ~7 days) carries the full story and reflection. The feed's
// pubDate years are wrong, so today's item is matched by month and day only. The picture is the
// og:image of the item's own page.
const SOTD = 'https://www.franciscanmedia.org/saint-of-the-day/';

// Story HTML -> [{h: heading} | {p: paragraph}], without the audio player, separators and image
// credits. After the Reflection only its paragraphs and an optional "Patron Saint of:" list are
// kept; book and video promotions after that are left out.
function saintBlocks(html) {
  const out = [];
  const re = /<(h[1-6]|p|ul|blockquote)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m, stage = 0;                                   // 0 story, 1 reflection, 2 patron list
  while ((m = re.exec(html))) {
    const heading = /^h/i.test(m[1]);
    const text = tagText(m[2], stage === 2 ? ' · ' : ' ');
    if (!text) continue;
    if (/^image\s*:/i.test(text)) continue;
    if (text.length < 160 && /images|wikimedia|commons/i.test(text)) continue;
    if (heading && /^reflection$/i.test(text)) stage = 1;
    else if (heading && stage === 1 && /patron saint/i.test(text)) { stage = 2; out.push({ h: text }); continue; }
    else if (heading && stage >= 1) break;
    else if (!heading && stage === 2) { out.push({ p: text }); break; }
    out.push(heading ? { h: text } : { p: text });
  }
  return out;
}
const metaOf = page => p => (new RegExp('<meta[^>]+property="' + p + '"[^>]+content="([^"]+)"', 'i').exec(page) || [])[1];
function imageOf(meta) {
  const src = meta('og:image');
  return src && /^https:\/\//.test(src) ? { src: decode(src), w: +meta('og:image:width') || 0, h: +meta('og:image:height') || 0 } : null;
}
async function saintImage(link) {
  return cached('sotdimg:' + link, 864e5, async () => {
    try {
      const res = await fetch(link, { headers: UA });
      return res.ok ? imageOf(metaOf(await res.text())) : null;
    } catch (e) { return null; }
  });
}
// The feed can lag behind the website. Then read the newest saints linked from the Saint of the
// Day index, accepting one only if its own heading says "Saint of the Day for <today>".
async function saintFromSite(date) {
  const res = await fetch(SOTD, { headers: UA });
  if (!res.ok) return null;
  const index = await res.text();
  const slugs = [...new Set((index.match(/https:\/\/www\.franciscanmedia\.org\/saint-of-the-day\/[a-z0-9-]+\//g) || [])
    .filter(u => !/\/(sort|calendar|feed|page)\//.test(u)))].slice(0, 2);
  const want = 'Saint of the Day for ' + FULL_MONTHS[+date.slice(5, 7) - 1] + ' ' + (+date.slice(8, 10));
  for (const link of slugs) {
    const page = await (await fetch(link, { headers: UA })).text();
    const start = page.indexOf('>' + want + '<');
    if (start < 0) continue;
    const from = page.lastIndexOf('<h', start);
    const refl = page.indexOf('>Reflection<', start);
    let end = refl > 0 ? page.indexOf('<hr', refl) : -1;
    if (end < 0) end = refl > 0 ? refl + 6000 : start + 12000;
    const meta = metaOf(page);
    const title = decode(meta('og:title') || '').replace(/\s*\|\s*Franciscan Media\s*$/i, '');
    return { date, title: title || 'Saint of the Day', link, image: imageOf(meta),
      blocks: saintBlocks(page.slice(from, end)), source: 'Franciscan Media · Saint of the Day' };
  }
  return null;
}
async function franciscanForDate(date) {
  const feed = await cached('sotd', 60 * 60e3, async () => {
    const res = await fetch(SOTD + 'feed/', { headers: Object.assign({ accept: 'application/rss+xml' }, UA) });
    if (!res.ok) throw new Error('Saint of the Day feed HTTP ' + res.status);
    return res.text();
  });
  const items = feed.split(/<item>/i).slice(1).map(x => {
    const g = t => (new RegExp('<' + t + '>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</' + t + '>', 'i').exec(x) || [])[1] || '';
    return { title: tagText(g('title')), link: g('link').trim(), pub: g('pubDate'), html: g('content:encoded') };
  });
  const want = (+date.slice(8, 10)) + ' ' + MONTHS[+date.slice(5, 7) - 1];
  const item = items.find(i => { const m = /(\d{1,2}) ([A-Z][a-z]{2})/.exec(i.pub); return m && (+m[1]) + ' ' + m[2] === want; });
  if (!item) {
    const site = await cached('sotdsite:' + date, 30 * 60e3, () => saintFromSite(date).catch(() => null));
    return site && site.blocks.length ? site : null;
  }
  return {
    date, title: item.title, link: item.link,
    image: /^https:\/\/www\.franciscanmedia\.org\//.test(item.link) ? await saintImage(item.link) : null,
    blocks: saintBlocks(item.html), source: 'Franciscan Media · Saint of the Day'
  };
}

// ------------------------------------------------------------------ Saint of the Day: Vatican News
// Used when Franciscan Media's saint that day isn't the one on the calendar.
const NAME_SKIP = new Set(['saint', 'saints', 'st', 'sts', 'blessed', 'bl', 'pope', 'bishop', 'bishops', 'priest', 'priests', 'deacon',
  'abbot', 'monk', 'religious', 'virgin', 'virgins', 'martyr', 'martyrs', 'doctor', 'church', 'the', 'of', 'and', 'companions', 'great', 'our', 'lady']);
function nameTokens(name) {
  return String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, ' ').split(/\s+/)
    .filter(w => w.length > 1 && !NAME_SKIP.has(w));
}
// Same saint if the official name's first distinctive word ("martin", "leo", "lourdes") appears in the other.
function sameSaint(official, other) {
  const a = nameTokens(official), b = new Set(nameTokens(other));
  return a.length > 0 && b.has(a[0]);
}
async function vaticanSaint(date, name) {
  const md = date.slice(5, 7) + '/' + date.slice(8, 10), base = 'https://www.vaticannews.va';
  const day = await fetch(base + '/en/saints/' + md + '.html', { headers: UA });
  if (!day.ok) return null;
  const html = await day.text();
  const links = [...new Set(html.match(new RegExp('/en/saints/' + md + '/[a-z0-9-]+\\.html', 'g')) || [])];
  if (!links.length) return null;
  const link = links.find(l => sameSaint(name, l.split('/').pop().replace(/-/g, ' '))) || links[0];
  const page = await (await fetch(base + link, { headers: UA })).text();
  const title = tagText((/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(page) || [])[1] || name);
  const start = page.indexOf('<h1');
  const stop = page.indexOf('</section>', start);
  const body = page.slice(start, stop > 0 ? stop : start + 20000).replace(/<span class="didascalia_img">[\s\S]*?<\/span>/g, '');
  const paras = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
    .map(m => tagText(m[1]).replace(/^.{0,120}?\(©[^)]*\)\s*/, ''))
    .filter(t => t.length > 40);
  const img = (/data-original="(\/content\/dam\/vaticannews\/santi\/[^"]+?\.(?:jpe?g|png))\/_jcr_content[^"]*"/i.exec(page) || [])[1];
  return {
    date, title, link: base + link,
    image: img ? { src: base + img + '/_jcr_content/renditions/cq5dam.web.1280.1280.jpeg', w: 0, h: 0 } : null,
    blocks: paras.map(p => ({ p })), source: 'Vatican News · Saint of the day'
  };
}

// ------------------------------------------------------------------ the Gospel: Word on Fire
// Word on Fire's Daily Gospel Reflections feed: the day's Gospel (NRSV-CE) and Bishop Barron's
// reflection. Today's item only.
const WOF_FEED = 'https://www.wordonfire.org/reflections/feed/';
async function wordOnFire(date) {
  const feed = await cached('wof', 60 * 60e3, async () => {
    const res = await fetch(WOF_FEED, { headers: Object.assign({ accept: 'application/rss+xml' }, UA) });
    if (!res.ok) throw new Error('Word on Fire feed HTTP ' + res.status);
    return res.text();
  });
  const want = FULL_MONTHS[+date.slice(5, 7) - 1] + ' ' + (+date.slice(8, 10)) + ', ' + date.slice(0, 4);
  const item = feed.split(/<item>/i).slice(1).find(x => ((/<title>([^<]*)<\/title>/.exec(x) || [])[1] || '').indexOf(want) >= 0);
  if (!item) return null;
  const html = (/<content:encoded>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content:encoded>/.exec(item) || [])[1] || '';
  // The heading has been both "Gospel Reading" and plain "Gospel".
  const gi = html.search(/>\s*(?:The\s+|Holy\s+)?Gospel(?:\s+Reading)?\s*</i), ri = html.search(/>\s*Reflection\s*</i);
  if (gi < 0) return null;
  const section = s => [...s.matchAll(/<(h[1-6]|p)[^>]*>([\s\S]*?)<\/\1>/gi)].map(m => ({ tag: m[1].toLowerCase(), text: tagText(m[2]) })).filter(x => x.text);
  const g = section(html.slice(gi, ri > gi ? ri : undefined));
  return {
    reference: (g.find(x => x.tag[0] === 'h' && /\d+:\d+/.test(x.text)) || {}).text || '',
    gospel: g.filter(x => x.tag === 'p').map(x => x.text),
    reflection: ri > 0 ? section(html.slice(ri)).filter(x => x.tag === 'p').map(x => x.text) : [],
    author: tagText((/<dc:creator>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/dc:creator>/.exec(item) || [])[1] || 'Bishop Robert Barron'),
    link: ((/<link>([^<]*)<\/link>/.exec(item) || [])[1] || '').trim(),
    source: 'Word on Fire · Daily Gospel Reflection (NRSV-CE)'
  };
}

// ------------------------------------------------------------------ the day's reading
// The Church's calendar decides: a memorial (3), feast (4) or optional memorial (2) of a saint
// gives a saint. Commemorations (memorials in Lent or Dec 17-24) give way to the season's
// weekday, and the Saturday memorial of the Blessed Virgin isn't a saint's day.
async function daily(env, date) {
  const map = await litcalYear(env, +date.slice(0, 4));
  const all = map[date] || [];
  const cel = all.find(c => c.grade >= 2 && c.grade <= 4 && !/saturday memorial of the blessed virgin/i.test(c.name));
  const findSaint = async () => {
    if (!cel) return null;
    const fm = await franciscanForDate(date).catch(() => null);
    if (fm && sameSaint(cel.name, fm.title)) return Object.assign({ official: cel.name }, fm);
    const vn = await vaticanSaint(date, cel.name).catch(() => null);
    return vn && vn.blocks.length ? Object.assign({ official: cel.name }, vn) : null;
  };
  const [saint, wof] = await Promise.all([findSaint(), wordOnFire(date).catch(() => null)]);
  // Name the day as the card does: an optional memorial doesn't replace the weekday.
  let day = all[0];
  if (day && day.grade <= 2) day = all.find(c => c.grade === 0) || day;
  return { date, day: day ? day.name : '', sunday: new Date(date + 'T12:00:00Z').getUTCDay() === 0,
    saint, gospel: wof && wof.gospel.length ? wof : null };
}
