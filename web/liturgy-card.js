// liturgy-card.js: today's liturgical day as a card for a touch screen (photo frame, wall tablet,
// kitchen dashboard). Plain ES5, no libraries, so it runs on old Android WebViews.
//
//   <link rel="stylesheet" href="liturgy-card.css">
//   <div id="liturgy"></div>
//   <script src="liturgy-card.js"></script>
//   <script>LiturgyCard.mount(document.getElementById('liturgy'), { api: 'https://your-worker.workers.dev' });</script>
//
// The card: the day's celebration with its rank and a bar in the liturgical colour, any optional
// memorials, the season and psalter week, the Rosary mysteries and Sunday cycle, and an Advent
// wreath that lights one more candle each Sunday of Advent (all five through Christmas).
// Tap it: Saint of the Day and Gospel & Reflection in two tabs (saint first, except Sundays).
// A banner reminds about Holy Days of Obligation from 3 PM the day before until noon on the day.
//
// Options:
//   api      the Worker's address (default: this page's own origin)
//   key      the Worker's ACCESS_KEY, if you set one
//   holyDays true (default) to show the Holy Day of Obligation banner
//   wreath   true (default) to show the Advent wreath
//   onOpen / onClose  called when the reading panel opens and closes (e.g. hold off a screensaver)
(function () {
  'use strict';

  var COLORS = { white: '#F4EFE2', red: '#C0262D', green: '#2E7D4F', purple: '#6B3FA0', violet: '#6B3FA0', rose: '#E58FB0', pink: '#E58FB0', black: '#222222', gold: '#C9A227' };
  var ORD = ['', 'First', 'Second', 'Third', 'Fourth'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function ymd(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function roman(n) { return ['', 'I', 'II', 'III', 'IV'][n] || ''; }
  function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} return null; }
  function closest(el, sel) {
    while (el && el.nodeType === 1) { if ((el.matches || el.msMatchesSelector || el.webkitMatchesSelector).call(el, sel)) return el; el = el.parentNode; }
    return null;
  }

  // ------------------------------------------------------------------ Advent wreath
  function dayNum(d) { return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5); }
  function firstAdvent(y) {
    var xmas = new Date(y, 11, 25), dow = xmas.getDay();
    return dayNum(xmas) - (dow === 0 ? 7 : dow) - 21;   // the Sunday before Christmas is the 4th
  }
  function wreathCandles(season, now) {
    season = String(season || '').toLowerCase();
    if (season === 'christmas') return 5;
    if (season !== 'advent') return 0;
    return Math.max(1, Math.min(4, Math.floor((dayNum(now) - firstAdvent(now.getFullYear())) / 7) + 1));
  }
  function wreathHTML(n) {
    if (!n) return '';
    // Four candles round the ring (two in front, two behind), the Christ candle in the middle.
    var C = [{ x: 22, b: 70, h: 40, c: '#6B3FA0' }, { x: 46, b: 62, h: 36, c: '#6B3FA0' }, { x: 74, b: 62, h: 36, c: '#E58FB0' }, { x: 98, b: 70, h: 40, c: '#6B3FA0' }];
    function candle(k) {
      var s = C[k], top = s.b - s.h;
      return '<rect x="' + (s.x - 5) + '" y="' + top + '" width="10" height="' + s.h + '" rx="2" fill="' + s.c + '"/>' +
        '<line x1="' + s.x + '" y1="' + top + '" x2="' + s.x + '" y2="' + (top - 4) + '" stroke="currentColor" stroke-width="1.5"/>' +
        (k < n ? '<path class="lc-flame" d="M' + s.x + ' ' + (top - 17) + 'c4 6 6 9 0 13c-6-4-4-7 0-13z" fill="#F6B73C"/>' : '');
    }
    var christ = n === 5 ? '<rect x="55" y="22" width="10" height="46" rx="2" fill="#FBF9F4" stroke="#C9C1B0"/><path class="lc-flame" d="M60 5c4 6 6 9 0 13c-6-4-4-7 0-13z" fill="#F6B73C"/>' : '';
    var ring = '<ellipse cx="60" cy="68" rx="54" ry="13" fill="none" stroke="#2F5D3A" stroke-width="9"/>' +
      '<ellipse cx="60" cy="68" rx="54" ry="13" fill="none" stroke="#4E8A55" stroke-width="3" stroke-dasharray="4 7"/>' +
      [[14, 64], [40, 79], [82, 79], [106, 64], [60, 57]].map(function (p) { return '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="2.6" fill="#B3261E"/>'; }).join('');
    return '<div class="lc-wreath" aria-label="Advent wreath"><svg viewBox="0 0 120 86" width="132" height="95">' + candle(1) + candle(2) + christ + ring + candle(0) + candle(3) + '</svg>' +
      '<div class="lc-wreath-cap">' + (n === 5 ? 'Christmas' : ORD[n] + ' week of Advent') + '</div></div>';
  }

  // ------------------------------------------------------------------ reading panel
  // The first lines of Franciscan Media's story ("Saint of the Day for November 7", the saint's
  // dates) become the subtitle. The picture is shown whole, so faces aren't cropped.
  function saintBody(d) {
    var blocks = (d.blocks || []).slice(), sub = [];
    while (blocks.length && sub.length < 2 && (blocks[0].h || '').length && /saint of the day|^\(|\d{3,4}/i.test(blocks[0].h)) sub.push(blocks.shift().h);
    var img = '';
    if (d.image && d.image.src) {
      var ratio = d.image.w && d.image.h ? d.image.h / d.image.w : 0.6;
      img = '<div class="lc-img" style="height:' + Math.round(Math.min(380, Math.max(220, 1040 * ratio))) + 'px"><img src="' + esc(d.image.src) + '" alt=""></div>';
    }
    return img +
      '<div class="lc-label">' + esc(sub.join(' · ') || 'Saint of the Day') + '</div>' +
      '<h2 class="lc-h">' + esc(d.title || 'Saint of the Day') + '</h2>' +
      blocks.map(function (b) { return b.h ? '<h3>' + esc(b.h) + '</h3>' : '<p>' + esc(b.p) + '</p>'; }).join('') +
      '<div class="lc-src">From ' + (d.link ? '<a href="' + esc(d.link) + '" target="_blank" rel="noopener">' + esc(d.source || '') + '</a>' : esc(d.source || '')) + '</div>';
  }
  function gospelBody(g, day) {
    return '<div class="lc-label">Gospel' + (day ? ' · ' + esc(day) : '') + '</div>' +
      '<h2 class="lc-h">' + esc(g.reference || 'Today’s Gospel') + '</h2>' +
      (g.gospel || []).map(function (p) { return '<p class="lc-quote">' + esc(p) + '</p>'; }).join('') +
      ((g.reflection || []).length ? '<h3>Reflection · ' + esc(g.author || '') + '</h3>' +
        g.reflection.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('') : '') +
      '<div class="lc-src">From ' + (g.link ? '<a href="' + esc(g.link) + '" target="_blank" rel="noopener">' + esc(g.source || 'Word on Fire') + '</a>' : esc(g.source || 'Word on Fire')) + '</div>';
  }

  function mount(el, opts) {
    opts = opts || {};
    var api = String(opts.api || '').replace(/\/+$/, '');
    var holyOn = opts.holyDays !== false, wreathOn = opts.wreath !== false;
    var lit = store('liturgyCard.today'), litNext = store('liturgyCard.next'), daily = store('liturgyCard.daily');
    var panel = null, banner = null, holyShownKey = '';

    function get(path) {
      var headers = {};
      if (opts.key) headers['X-Liturgy-Key'] = opts.key;
      return fetch(api + path, { headers: headers, cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; });
    }
    function refreshLiturgy() {
      var now = new Date(), day = ymd(now), next = ymd(addDays(now, 1));
      get('/api/liturgy?date=' + day).then(function (d) { if (d && d.date === day) { lit = d; store('liturgyCard.today', d); render(); } }).catch(function () {});
      // Tomorrow too, for the Holy Day reminder the evening before.
      get('/api/liturgy?date=' + next).then(function (d) { if (d && d.date === next) { litNext = d; store('liturgyCard.next', d); holyTick(); } }).catch(function () {});
    }
    function refreshDaily() {
      var day = ymd(new Date());
      get('/api/daily?date=' + day).then(function (d) {
        if (!d || d.date !== day) return;
        daily = d; store('liturgyCard.daily', d);
        if (d.saint && d.saint.image && d.saint.image.src) (new Image()).src = d.saint.image.src;   // no pop-in later
        render();
      }).catch(function () {});
    }
    function dailyToday() { return daily && daily.date === ymd(new Date()) && (daily.saint || daily.gospel) ? daily : null; }
    function saintFirst(d) { return !!(d.saint && !d.sunday); }

    function render() {
      if (!lit || lit.date !== ymd(new Date()) || !lit.celebrations || !lit.celebrations.length) { el.innerHTML = ''; el.className = 'lc'; return; }
      // An optional memorial or commemoration doesn't replace the day: lead with the weekday and
      // list the optional celebrations under it.
      var all = lit.celebrations, c = all[0];
      if (c.grade <= 2) c = all.filter(function (x) { return x.grade === 0; })[0] || c;
      var opt = all.filter(function (x) { return x !== c && x.grade >= 1 && x.grade <= 3; });
      var col = String(c.color[0] || 'green').toLowerCase(), sw = COLORS[col] || COLORS.green;
      var meta = [c.season, c.psalter ? 'Week ' + roman(c.psalter) + ' of the Psalter' : ''].filter(Boolean).join(' · ');
      var x = lit.extra && (lit.extra.rosary || lit.extra.sundayCycle) ? lit.extra : null;
      var d = dailyToday(), go = '';
      if (d) go = saintFirst(d) || !d.gospel ? 'Saint of the Day: <b>' + esc(d.saint.title) + '</b> ›' : 'Gospel: <b>' + esc(d.gospel.reference || 'today’s reading') + '</b> ›';
      el.className = 'lc on' + (d ? ' lc--tap' : '');
      el.innerHTML = '<div class="lc-bar" style="background:' + sw + '"></div><div class="lc-body">' +
        '<div class="lc-label">' + esc(c.rank || 'Today') + (c.obligation ? ' · Holy Day of Obligation' : '') + '</div>' +
        '<div class="lc-name">' + esc(c.name) + '</div>' +
        (opt.length ? '<div class="lc-opt">' + opt.map(function (o) { return esc(o.rank) + ': ' + esc(o.name); }).join(' · ') + '</div>' : '') +
        '<div class="lc-meta"><span class="lc-dot" style="background:' + sw + '"></span>' + esc(col.charAt(0).toUpperCase() + col.slice(1)) + (meta ? ' · ' + esc(meta) : '') + '</div>' +
        (x ? '<div class="lc-meta">' + esc([x.rosary ? 'Rosary: ' + x.rosary + ' Mysteries' : '', x.sundayCycle ? 'Year ' + x.sundayCycle : '', x.weekdayCycle ? 'Weekday cycle ' + x.weekdayCycle : ''].filter(Boolean).join(' · ')) + '</div>' : '') +
        (go ? '<div class="lc-go">' + go + '</div>' : '') +
        '</div>' + (wreathOn ? wreathHTML(wreathCandles(c.season, new Date())) : '');
      holyTick();
    }

    function openReading() {
      var d = dailyToday();
      if (!d) { refreshDaily(); return; }
      var tabs = [];
      if (d.saint) tabs.push(['saint', 'Saint of the Day']);
      if (d.gospel) tabs.push(['gospel', 'Gospel & Reflection']);
      if (!saintFirst(d)) tabs.reverse();
      var tab = tabs[0][0];
      function body() {
        return (tabs.length > 1 ? '<div class="lc-tabs">' + tabs.map(function (t) { return '<button data-lctab="' + t[0] + '" class="' + (t[0] === tab ? 'is-on' : '') + '">' + t[1] + '</button>'; }).join('') + '</div>' : '') +
          (tab === 'saint' ? saintBody(d.saint) : gospelBody(d.gospel, d.day));
      }
      closePanel();
      panel = document.createElement('div');
      panel.className = 'lc-panel';
      panel.innerHTML = '<div class="lc-sheet"><button class="lc-close" aria-label="Close">×</button><div class="lc-scroll"><div class="lc-read">' + body() + '</div></div></div>';
      panel.addEventListener('click', function (e) {
        var t = closest(e.target, '[data-lctab]');
        if (t) { tab = t.getAttribute('data-lctab'); panel.querySelector('.lc-read').innerHTML = body(); panel.querySelector('.lc-scroll').scrollTop = 0; return; }
        if (e.target === panel || closest(e.target, '.lc-close')) closePanel();
      });
      document.body.appendChild(panel);
      if (opts.onOpen) opts.onOpen();
    }
    function closePanel() {
      if (!panel) return;
      panel.parentNode.removeChild(panel); panel = null;
      if (opts.onClose) opts.onClose();
    }

    // Holy Days of Obligation (not Sundays): from 3 PM the day before, and that morning until noon.
    function obligation(d) {
      var c = d && d.celebrations && d.celebrations.filter(function (x) { return x.obligation; })[0];
      return c ? c.name.split(',')[0] : '';
    }
    function holyTick() {
      if (!holyOn) return;
      var now = new Date(), h = now.getHours(), tomorrow = addDays(now, 1), key = '', title = '', sub = '';
      if (h >= 15 && litNext && litNext.date === ymd(tomorrow) && tomorrow.getDay() !== 0 && obligation(litNext)) {
        key = litNext.date; title = 'Tomorrow is a Holy Day of Obligation';
        sub = obligation(litNext) + ' · ' + DAYS[tomorrow.getDay()] + ', ' + MONTHS[tomorrow.getMonth()] + ' ' + tomorrow.getDate();
      } else if (h < 12 && lit && lit.date === ymd(now) && now.getDay() !== 0 && obligation(lit)) {
        key = lit.date; title = 'Today is a Holy Day of Obligation'; sub = obligation(lit);
      }
      if (!key) { if (banner) { banner.parentNode.removeChild(banner); banner = null; } return; }
      if (holyShownKey === key || store('liturgyCard.holyClosed') === key) return;
      holyShownKey = key;
      banner = document.createElement('div');
      banner.className = 'lc-holy';
      banner.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M12 3v18M7 8h10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>' +
        '<div><b>' + esc(title) + '</b><span>' + esc(sub) + '</span></div><button>OK</button>';
      banner.querySelector('button').addEventListener('click', function () {
        store('liturgyCard.holyClosed', key);
        if (banner) { banner.parentNode.removeChild(banner); banner = null; }
      });
      document.body.appendChild(banner);
    }

    el.addEventListener('click', function () { if (dailyToday()) openReading(); });
    render();
    refreshLiturgy(); refreshDaily();
    var shown = ymd(new Date());
    setInterval(function () {                           // a new day: fetch again
      var n = ymd(new Date());
      if (n !== shown) { shown = n; refreshLiturgy(); refreshDaily(); render(); }
      else holyTick();
    }, 60e3);
    setInterval(refreshDaily, 30 * 60e3);               // the sources publish at different times
    setInterval(refreshLiturgy, 6 * 3600e3);

    return { open: openReading, close: closePanel, refresh: function () { refreshLiturgy(); refreshDaily(); } };
  }

  window.LiturgyCard = { mount: mount };
})();
