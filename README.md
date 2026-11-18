# liturgy-frame

Bring the Church's day into your home: a small card for a photo frame, wall tablet or kitchen
dashboard that shows today's feast in its liturgical colour, the Saint of the Day, the day's
Gospel with Bishop Barron's reflection, an Advent wreath that lights itself, and a reminder before
every Holy Day of Obligation.

It comes in two parts. **A Cloudflare Worker** (free plan is plenty) gathers the day's
liturgy from trusted Catholic sources. **A drop-in card** (`web/liturgy-card.js`, plain JavaScript,
no libraries) shows it on your screen and runs fine on old Android photo frames.

Have a TV instead? See **[liturgy-tv](https://github.com/willburenheide/liturgy-tv)**, which uses this same Worker.

## What it shows

- **Today's celebration**, e.g. *Saint Elizabeth of Hungary, Religious*, with its rank (Memorial,
  Feast, Solemnity…), a bar in the liturgical colour, any optional memorials, the season and psalter
  week, the Rosary mysteries of the day, and the Sunday/weekday lectionary cycle.
- **Tap the card for the day's reading**, in two tabs:
  - **Saint of the Day**: the story and reflection from Franciscan Media, with the saint's
    picture. If Franciscan Media writes about a different saint than the calendar's, it uses Vatican
    News instead.
  - **Gospel & Reflection**: the day's Gospel (NRSV-CE) and Bishop Barron's reflection from Word on Fire.

  The Church's calendar decides which tab comes first. On a saint's memorial or feast you see the
  saint. On Sundays, solemnities and plain weekdays you see the Gospel.
- **Advent wreath**: one more candle each Sunday of Advent (violet, violet, rose for Gaudete,
  violet), and all four plus the white Christ candle through the Christmas season.
- **Holy Day of Obligation reminder** from 3 PM the day before until noon on the day. In the US
  it knows when the obligation is lifted, for example when Jan 1, Aug 15 or Nov 1 falls on a
  Saturday or Monday.

## Set it up (about 10 minutes)

You need [Node.js](https://nodejs.org) and a free [Cloudflare](https://dash.cloudflare.com/sign-up) account.

```bash
git clone https://github.com/willburenheide/liturgy-frame
cd liturgy-frame
npm install
npx wrangler dev        # try it at http://localhost:8787
npx wrangler deploy     # put it online: https://liturgy-frame.<you>.workers.dev
```

Open the address `deploy` prints: the demo page shows the card working.

Then put the card on your own dashboard:

```html
<link rel="stylesheet" href="https://liturgy-frame.<you>.workers.dev/liturgy-card.css">
<div id="liturgy"></div>
<script src="https://liturgy-frame.<you>.workers.dev/liturgy-card.js"></script>
<script>
  LiturgyCard.mount(document.getElementById('liturgy'), {
    api: 'https://liturgy-frame.<you>.workers.dev'
  });
</script>
```

Card options: `key` (if you set an access key), `holyDays: false`, `wreath: false`,
`onOpen` / `onClose` (to pause a screensaver while someone is reading). Change the `--lc-*`
colours in `liturgy-card.css` to match your dashboard. Dark mode follows the device setting.

## Settings (`wrangler.jsonc`)

| Setting | What it does |
|---|---|
| `CALENDAR` | Which national calendar. Default `nation/US`. Others: `nation/CA`, `nation/IT`, `nation/NL`… ([list](https://litcal.johnromanodorazio.com/api/v5/calendars)), or `""` for the General Roman Calendar. |
| `TIMEZONE` | Your time zone, so tomorrow's reading is fetched before midnight. |
| `LITURGY_KV` | Optional storage, so the Worker asks the sources less often. Instructions are in the file. |
| `ACCESS_KEY` | Optional secret (`npx wrangler secret put ACCESS_KEY`). Without it, anyone with the address can use your Worker. That's harmless because everything is public, but the key keeps your free quota for yourself. |

## The API

Both routes take an optional `?date=YYYY-MM-DD` (within 3 days of today) and send CORS headers, so any page can call them.

- `GET /api/liturgy`: `{ date, celebrations: [{ name, grade, rank, color, season, psalter, obligation }], extra: { rosary, sundayCycle, weekdayCycle } }`
- `GET /api/daily`: `{ date, day, sunday, saint: { title, image, blocks, source, link } | null, gospel: { reference, gospel, reflection, author, source, link } | null }`

## Sources, and being a good neighbour

This project stores no texts itself. Each day it reads them from their publishers and always shows their names:

- **Liturgical Calendar API**: [litcal.johnromanodorazio.com](https://litcal.johnromanodorazio.com), open source, by Fr. John Romano D'Orazio
- **liturgy.day**: Rosary mysteries and lectionary cycles ([liturgy.day](https://liturgy.day), open source)
- **Franciscan Media**: [Saint of the Day](https://www.franciscanmedia.org/saint-of-the-day/)
- **Vatican News**: [Saints](https://www.vaticannews.va/en/saints.html)
- **Word on Fire**: [Daily Gospel Reflections](https://www.wordonfire.org/reflections/) by Bishop Robert Barron

Please keep the credit lines, and keep this for home and parish use. These ministries publish
their work freely, and we want to stay good guests on their sites. The Worker caches each answer
for hours, so a whole household's screens make only a few requests a day. If you want to use their
text in anything commercial, ask the publisher first.

Their pages sometimes change. If the saint or Gospel stops showing up, please
[open an issue](https://github.com/willburenheide/liturgy-frame/issues).

## Credits

The card first ran on a family photo-frame dashboard built on Wes Bos's
[photo-frame-dashboard](https://github.com/wesbos/photo-frame-dashboard). The project is
shared here for anyone in the Church building something similar.

*Ad majorem Dei gloriam.* MIT licensed.
