const axios = require('axios')
const crypto = require('crypto')
const express = require('express')
const expresshbs = require('express-handlebars')
const logger = require('morgan')
const strftimeCST = require('strftime').timezone(60*8)
const websocket = require('ws')

const app = express()

const http = require('http')
const server = http.createServer(app)
const wss = new websocket.Server({
  server,
})

app.use(logger('dev'))
app.use(express.json())
app.use(express.urlencoded({ extended: false }))

app.engine('.html', expresshbs({ extname: '.html', defaultLayout: false }))
app.set('view engine', '.html')
app.set('views', './views')

/* GET index page */
app.get('/', (req, res) => {
  res.render('index', { BANK, CURRENCY })
})

/* CONNECT websocket */
wss.on('connection', async (ws) => {
  console.log('ws: Client Connected!')
  const history = {
    '1m': await loadPoints(BANK, CURRENCY, '1m'),
    '1h': await loadPoints(BANK, CURRENCY, '1h'),
  }
  ws.send(JSON.stringify(history))
})

module.exports = { app, server }

// data feed
class Point {
  constructor(time, value) {
    this.time = Number(time)
    this.timeHuman = new Date(this.time * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
    this.value = value
  }
  static eq(a, b) {
    return a.time === b.time && a.value === b.value
  }
}

roundTimeTo = (time, round) => { return Math.floor(Number(time) / round) * round }

const ioredis = require('ioredis')
const redis = new ioredis(process.env['REDIS_URL'])

const max1m = 60 * 24   // 1d
const max1h = 24 * 30   // 30d

var cursorrt, cursor1m, cursor1h

savePoint = (point, bank, currency, t) => {
  const key1m = `FOREX:${bank}:${currency}:1m`
  const key1h = `FOREX:${bank}:${currency}:1h`

  var payload = {}

  // rt
  if (!cursorrt || !Point.eq(cursorrt, point)) {
    console.log(`${bank}/${currency} - ${point.timeHuman} - ${point.value}`)
    cursorrt = point
    payload['rt'] = [point]
  }

  const multi = redis.multi()

  // 1m
  if (!cursor1m || (point.time - cursor1m.time) > 60) {
    const point1m = new Point(roundTimeTo(point.time, 60), point.value)
    multi.lpush(key1m, `${point1m.time},${point1m.value}`).ltrim(key1m, 0, max1m - 1)
    cursor1m = point1m
    payload['1m'] = [point1m]
  }

  // 1h
  if (!cursor1h || (point.time - cursor1h.time) > 3600) {
    const point1h = new Point(roundTimeTo(point.time, 3600), point.value)
    multi.lpush(key1h, `${point1h.time},${point1h.value}`).ltrim(key1h, 0, max1h - 1)
    cursor1h = point1h
    payload['1h'] = [point1h]
  }

  // save point
  multi
    .exec()
    .catch(e => {
      console.log('savePoint() Error:', e)
    })

  // ignore empty payload
  if ((o => { for (let _ in o) { return false } return true })(payload)) return

  // broadcast points
  wss.clients.forEach(client => {
    client.readyState === websocket.OPEN && client.send(JSON.stringify(payload))
  })
}

loadPoints = async (bank, currency, precision) => {
  const key = `FOREX:${bank}:${currency}:${precision}`
  return redis
    .lrange(key, 0, -1)
    .then(result => {
      let points = []
      // construct point object and array from line format: "time,value"
      for (const sp of result) {
        const [time, value] = sp.split(',')
        points.push(new Point(time, value))
      }
      // update cursor point time
      if (points.length > 0) {
        global[`cursor${precision}`] = points[points.length - 1]
      }
      return points
    })
    .catch(e => {
      console.log('loadPoints() Error:', e)
    })
}

class KYLC {
  constructor(bank, currency) {
    this.bank = bank
    this.currency = currency
  }
  fetch() {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replaceAll('-', '')
    // java: "s" + new SimpleDateFormat("d3MM").format(today) + "ky" + ltrim(new SimpleDateFormat("yyyy").format(today), '2');
    const rnds = 's' + strftimeCST('%e').trim() + '3' + strftimeCST('%m') + 'ky' + strftimeCST('%Y').slice(1)
    const code = crypto.createHash('md5').update(rnds).digest('hex')
    axios({
      method: 'get',
      url: `https://www.kuaiyilicai.com/huilv/mobile/trend_ex/${this.bank.toUpperCase()}/cny/${this.currency.toLowerCase()}/${today}/${today}?access_code=${code}`,
      headers: {
        'User-Agent': 'kyhuilv/28000 CFNetwork/1220.1 Darwin/20.3.0',
      },
      timeout: INTERVAL,
    })
    .then(response => {
      const data = response.data
      // ignore invalid response
      if (!data) return
      if (typeof data !== 'object') return

      for (const rp of data) {
        // // rp sample
        // {
        //   "base_ccy_id": "CNY",
        //   "capture_time": "2021-01-29 00:00:00",
        //   "ccy_id": "CAD",
        //   "chao_buy": 4.8806000000,
        //   "chao_sell": 5.0342000000,
        //   "date": "2021-01-29 00:00:00",
        //   "exchangerate_id": 290573583,
        //   "hui_buy": 5.0010000000,
        //   "hui_sell": 5.0342000000,
        //   "middle_rate": 5.0176000000,
        //   "ref_time": "2021-01-29 17:17:31",
        //   "source_code": "BOB"
        // }

        // transform raw data into point object
        const point = new Point(Date.parse(`${rp.ref_time} GMT+0800`)/1000, rp.hui_sell * 100)

        // save and broadcast point
        savePoint(point, this.bank, this.currency)

        break
      }
    })
  }
}

class CMBC extends KYLC {
  fetch() {
    axios({
      method: 'get',
      url: 'https://m1.cmbc.com.cn:8209/CMBC_MWS/priceServlet.shtml?action=exchangeSS&callback=initHangQingNext',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148/requestByNative/cmbc.geren.5.11',
      },
      timeout: INTERVAL,
    })
    .then(response => {
      const data = JSON.parse(response.data.replace(/^initHangQingNext\(|\)/g, ''))['list']
      for (const rp of data) {
        // // rp sample
        // {
        //   "NEBY": "527.43",
        //   "BYSQ": "",
        //   "CURRENCY_NAME": "CADRMB",
        //   "CXFG": "1",
        //   "SLSQ": "",
        //   "NESL": "532.03",
        //   "LEFT_CURRENCY_NAME": "CAD",
        //   "RIGHT_CURRENCY_NAME": "RMB",
        //   "UP_TIME": "2019-11-13 13:53:51",
        //   "ERCD": "00000",
        //   "NEMD": "529.73"
        // }

        // filter point
        if (rp.LEFT_CURRENCY_NAME !== this.currency)
          continue
        if (rp.CXFG !== '1')
          continue

        // transform raw data into point object
        const point = new Point(Date.parse(`${rp.UP_TIME} GMT+0800`)/1000, rp.NESL)

        // save and broadcast point
        savePoint(point, this.bank, this.currency)

        break
      }
    })
    .catch(e => {
      console.log(`fetch() Error:`, e)
    })
  }
}

const BANK = process.env['BANK']
const CURRENCY = process.env['CURRENCY']
const INTERVAL = 5000

setInterval(() => {

  new ({ CMBC }[BANK] || KYLC)(BANK, CURRENCY).fetch()

}, INTERVAL)
