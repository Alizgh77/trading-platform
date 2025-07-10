let chart, candleSeries, emaSeries, markerSeries;
let fullData = [], currentIndex = 0, intervalId = null;
let currentTf = '1', emaEnabled = false;
let position = null;
let positionLines = { entry: null, tp: null, sl: null };
let balance = 10000, equity = 10000;

function convertToTimestamp(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('.').map(Number);
  const [h = 0, min = 0, sec = 0] = (timeStr || '00:00:00').split(':').map(Number);
  return Math.floor(new Date(y, m - 1, d, h, min, sec).getTime() / 1000);
}

async function loadCSV(tf) {
  const filename = `data/FXCM_XAUUSD-${tf}.csv`;
  const response = await fetch(filename);
  const text = await response.text();
  return text.split(/\r?\n/).filter(Boolean).map(line => {
    const parts = line.includes(',') ? line.split(',') : line.split('\t');
    if (parts.length < 6) return null;
    const [date, timeMaybe, o, h, l, c] = parts;
    const time = timeMaybe.includes(':') ? timeMaybe : '00:00:00';
    return { time: convertToTimestamp(date, time), open: +o, high: +h, low: +l, close: +c };
  }).filter(Boolean);
}

function renderChart() {
  document.getElementById('chart').innerHTML = "";
  emaSeries = null;
  chart = LightweightCharts.createChart(document.getElementById('chart'), {
    width: document.getElementById('chart').clientWidth,
    height: 500,
    layout: { background: { color: '#fff' }, textColor: '#000' },
    grid: { vertLines: { visible: false }, horzLines: { visible: false } },
    timeScale: { timeVisible: true, secondsVisible: true },
    priceScale: { borderVisible: true }
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: '#0099ff', downColor: '#005577',
    borderVisible: false,
    wickUpColor: '#0099ff', wickDownColor: '#005577',
  });

  markerSeries = candleSeries;
}

function updateIndicators(data) {
  if (emaEnabled) {
    if (!emaSeries) emaSeries = chart.addLineSeries({ color: 'orange', lineWidth: 2 });
    const emaData = [], emaLength = 20, mult = 2 / (emaLength + 1);
    let prev = data[0].close;
    data.forEach(d => {
      const ema = (d.close - prev) * mult + prev;
      prev = ema;
      emaData.push({ time: d.time, value: ema });
    });
    emaSeries.setData(emaData);
  }
}

function updateChart() {
  const data = fullData.slice(0, currentIndex + 1);
  candleSeries.setData(data);
  updateIndicators(data);
  updateEquity(fullData[currentIndex]);
}

function nextCandle() {
  if (currentIndex < fullData.length - 1) {
    currentIndex++;
    updateChart();
    checkPosition(fullData[currentIndex]);
  }
}

function prevCandle() {
  if (currentIndex > 0) {
    currentIndex--;
    updateChart();
  }
}

function play() {
  if (!intervalId) {
    intervalId = setInterval(() => {
      nextCandle();
      if (currentIndex >= fullData.length - 1) pause();
    }, 500);
  }
}

function pause() {
  clearInterval(intervalId);
  intervalId = null;
}

function openPosition(type) {
  if (position) return alert("You already have an open position!");

  const tpInput = parseFloat(document.getElementById("tpInput").value);
  const slInput = parseFloat(document.getElementById("slInput").value);
  const riskInput = parseFloat(document.getElementById("riskInput").value);
  if (!riskInput || !slInput) return alert("Risk and SL % are required!");

  const candle = fullData[currentIndex];
  const entry = candle.close;
  const tp = tpInput ? (type === 'buy' ? entry * (1 + tpInput / 100) : entry * (1 - tpInput / 100)) : null;
  const sl = type === 'buy' ? entry * (1 - slInput / 100) : entry * (1 + slInput / 100);
  const riskAmount = (riskInput / 100) * balance;
  const size = riskAmount / Math.abs(entry - sl);

  position = {
    type, entryPrice: entry, tp, sl,
    entryTime: candle.time, risk: riskAmount,
    size, closed: false
  };

  positionLines.entry = candleSeries.createPriceLine({ price: entry, color: 'gray', lineWidth: 1, title: 'Entry' });
  if (tp) positionLines.tp = candleSeries.createPriceLine({ price: tp, color: 'green', lineWidth: 1, title: 'TP' });
  positionLines.sl = candleSeries.createPriceLine({ price: sl, color: 'red', lineWidth: 1, title: 'SL' });

  updateEquity(candle);
}

function checkPosition(candle) {
  if (!position || position.closed) return;
  const hitTP = position.tp && (
    position.type === 'buy' ? candle.high >= position.tp : candle.low <= position.tp
  );
  const hitSL = position.type === 'buy' ? candle.low <= position.sl : candle.high >= position.sl;

  if (hitTP || hitSL) {
    position.closed = true;
    const exit = hitTP ? position.tp : position.sl;
    const pnl = (position.type === 'buy')
      ? (exit - position.entryPrice) * position.size
      : (position.entryPrice - exit) * position.size;

    balance += pnl;
    equity = balance;

    updateMetrics();
    clearPosition();
  } else {
    updateEquity(candle);
  }
}

function updateEquity(candle) {
  if (position && !position.closed) {
    const diff = position.type === 'buy'
      ? candle.close - position.entryPrice
      : position.entryPrice - candle.close;
    const floating = diff * position.size;
    equity = balance + floating;
    document.getElementById('floating').textContent = floating.toFixed(2);
  } else {
    equity = balance;
    document.getElementById('floating').textContent = "0.00";
  }
  updateMetrics();
}

function closePosition() {
  if (!position) return;
  const candle = fullData[currentIndex];
  const exit = candle.close;
  const pnl = (position.type === 'buy')
    ? (exit - position.entryPrice) * position.size
    : (position.entryPrice - exit) * position.size;

  balance += pnl;
  equity = balance;
  position.closed = true;
  updateMetrics();
  clearPosition();
}

function clearPosition() {
  if (positionLines.entry) candleSeries.removePriceLine(positionLines.entry);
  if (positionLines.tp) candleSeries.removePriceLine(positionLines.tp);
  if (positionLines.sl) candleSeries.removePriceLine(positionLines.sl);
  position = null;
  positionLines = { entry: null, tp: null, sl: null };
}

function updateMetrics() {
  document.getElementById('balance').textContent = balance.toFixed(2);
  document.getElementById('equity').textContent = equity.toFixed(2);
}

function addIndicator() {
  if (document.getElementById('indicatorSelect').value === 'ema') {
    emaEnabled = true;
    updateChart();
  }
}

function removeIndicator() {
  emaEnabled = false;
  if (emaSeries) {
    chart.removeSeries(emaSeries);
    emaSeries = null;
  }
  updateChart();
}

async function setTimeframe(tf) {
  currentTf = tf;
  currentIndex = 0;
  fullData = await loadCSV(currentTf);
  renderChart();
  updateChart();
}

window.onload = async function () {
  await setTimeframe(currentTf);
};

window.setTimeframe = setTimeframe;
window.play = play;
window.pause = pause;
window.prevCandle = prevCandle;
window.nextCandle = nextCandle;
window.openPosition = openPosition;
window.closePosition = closePosition;
window.addIndicator = addIndicator;
window.removeIndicator = removeIndicator;
