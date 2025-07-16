let chart, candleSeries, emaSeries;
let fullData = [], currentIndex = 0, intervalId = null;
let currentTf = '1', emaEnabled = false;
let position = null;
let positionLines = { entry: null, tp: null, sl: null };
let balance = 10000, equity = 10000;
let syncedTime = null;
let allData = [];
let visibleStartIndex = 0;
let isFirstLoad = true;


const pipSize = 0.01;
const contractSize = 100000;
const spreadPips = 2;
const spread = pipSize * spreadPips;
const commissionPerLot = 7;

function convertToTimestamp(dateStr, timeStr) {
    const [y, m, d] = dateStr.split('.').map(Number);
    const [h = 0, min = 0, sec = 0] = (timeStr || '00:00:00').split(':').map(Number);
    return Math.floor(new Date(y, m - 1, d, h, min, sec).getTime() / 1000);
}

async function loadCSV(tf) {
    const response = await fetch(`data/FXCM_XAUUSD-${tf}.csv`);
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
        layout: { background: { color: '#fff' }, textColor: '#000' },
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
        timeScale: { timeVisible: true, secondsVisible: true },
        priceScale: { borderVisible: true },
        height: 500
    });

    candleSeries = chart.addCandlestickSeries({
        upColor: '#0099ff', downColor: '#005577',
        borderVisible: false,
        wickUpColor: '#0099ff', wickDownColor: '#005577',
    });

    redrawPositionLines();

}

function updateIndicators(data) {
    if (!emaEnabled) return;
    if (!emaSeries) emaSeries = chart.addLineSeries({ color: 'orange', lineWidth: 2 });

    const emaLength = 20;
    const mult = 2 / (emaLength + 1);
    let prev = data[0].close;
    const emaData = data.map(d => {
        const ema = (d.close - prev) * mult + prev;
        prev = ema;
        return { time: d.time, value: ema };
    });

    emaSeries.setData(emaData);
}

function updateChart() {
    const visibleData = fullData.filter(d => d.time <= syncedTime);

    const lastCandle = visibleData[visibleData.length - 1];
    const tfSeconds = { '1': 60, '5': 300, '15': 900 }[currentTf];

    // ✅ اضافه کردن 30 کندل فرضی با فاصله زمانی مشخص
    const dummyCandles = [];
    for (let i = 1; i <= 100; i++) {
        const time = lastCandle.time + i * tfSeconds;
        dummyCandles.push({
            time,
            open: lastCandle.close,
            high: lastCandle.close,
            low: lastCandle.close,
            close: lastCandle.close,
        });
    }

    const combinedData = [...visibleData, ...dummyCandles];
    candleSeries.setData(combinedData);
    updateIndicators(visibleData);

    const currentCandle = fullData.find(d => d.time === syncedTime);
    if (currentCandle) updateEquity(currentCandle);

    // ✅ اضافه کردن فضای آینده در محور زمان
    try {
        chart.timeScale().applyOptions({
            rightOffset: 0 // فضای خالی از کندل‌ها در سمت راست
        });
    } catch (err) {
        console.warn("applyOptions for rightOffset failed:", err);
    }
}


function nextCandle() {
    const nextIndex = fullData.findIndex(d => d.time > syncedTime);
    if (nextIndex !== -1) {
        syncedTime = fullData[nextIndex].time;
        currentIndex = nextIndex;
        updateChart();
        checkPosition(fullData[nextIndex]);
    }
}


function prevCandle() {
    const prevList = fullData.filter(d => d.time < syncedTime);
    if (prevList.length > 0) {
        const prev = prevList[prevList.length - 1];
        syncedTime = prev.time;
        currentIndex = fullData.findIndex(d => d.time === syncedTime);
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

    if (balance <= 0) {
        alert("Your balance is zero or negative. You cannot open a new position.");
        return;
    }

    const tpInput = parseFloat(document.getElementById("tpInput").value);
    const slInput = parseFloat(document.getElementById("slInput").value);
    const riskInput = parseFloat(document.getElementById("riskInput").value);
    const riskType = document.getElementById("riskType").value;

    if (!riskInput || !slInput) return alert("Risk and SL % are required!");

    const nextCandle = fullData[currentIndex];
    if (!nextCandle) return alert("No candle available for entry!");

    const bid = nextCandle.close;
    const ask = bid + spread;
    const entry = type === 'buy' ? ask : bid;

    const tp = tpInput
        ? (type === 'buy' ? entry * (1 + tpInput / 100) : entry * (1 - tpInput / 100))
        : null;

    const sl = type === 'buy'
        ? entry * (1 - slInput / 100)
        : entry * (1 + slInput / 100);

    const stopDistance = Math.abs(entry - sl);
    let size = 0, riskAmount = 0;

    if (riskType === 'percent') {
        riskAmount = (riskInput / 100) * balance;
        size = riskAmount / stopDistance;
    } else if (riskType === 'dollar') {
        riskAmount = riskInput;
        size = riskAmount / stopDistance;
    } else if (riskType === 'lot') {
        size = riskInput * contractSize;
        riskAmount = stopDistance * size;
    }

    const commissionEntry = commissionPerLot * (size / contractSize);
    balance -= commissionEntry;

    position = {
        type, entryPrice: entry, tp, sl, size,
        risk: riskAmount, commission: commissionEntry,
        entryTime: nextCandle.time, closed: false
    };

    // 📌 رسم خطوط روی قیمت واقعی
    positionLines.entry = candleSeries.createPriceLine({ price: entry, color: 'gray', lineWidth: 1, title: 'Entry' });
    if (tp) positionLines.tp = candleSeries.createPriceLine({ price: tp, color: 'green', lineWidth: 1, title: 'TP' });
    positionLines.sl = candleSeries.createPriceLine({ price: sl, color: 'red', lineWidth: 1, title: 'SL' });

    // 🎯 نمایش خطوط Ask و Bid
    positionLines.ask = candleSeries.createPriceLine({ price: ask, color: 'purple', lineWidth: 1, title: 'Ask' });
    positionLines.bid = candleSeries.createPriceLine({ price: bid, color: 'blue', lineWidth: 1, title: 'Bid' });

    updateEquity(nextCandle);
}


function checkPosition(candle) {
    if (!position || position.closed) return;
    const hitTP = position.tp && (
        position.type === 'buy' ? candle.high >= position.tp : candle.low <= position.tp
    );
    const hitSL = position.type === 'buy'
        ? candle.low <= position.sl
        : candle.high >= position.sl;

    if (hitTP || hitSL) {
        position.closed = true;
        const exit = hitTP ? position.tp : position.sl;
        let pnl = (position.type === 'buy')
            ? (exit - position.entryPrice) * position.size
            : (position.entryPrice - exit) * position.size;

        const commissionExit = commissionPerLot * (position.size / contractSize);
        pnl -= commissionExit;

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
        const rawDiff = position.type === 'buy'
            ? candle.close - position.entryPrice
            : position.entryPrice - candle.close;

        const floating = rawDiff * position.size;
        const commissionExit = commissionPerLot * (position.size / contractSize);
        const totalFloating = floating - commissionExit;

        equity = balance + totalFloating;
        document.getElementById('floating').textContent = totalFloating.toFixed(2);
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

    let pnl = (position.type === 'buy')
        ? (exit - position.entryPrice) * position.size
        : (position.entryPrice - exit) * position.size;

    const commissionExit = commissionPerLot * (position.size / contractSize);
    pnl -= commissionExit;

    balance += pnl;
    equity = balance;
    position.closed = true;
    updateMetrics();
    clearPosition();
}

function clearPosition() {
    ['entry', 'tp', 'sl', 'bid', 'ask'].forEach(k => {
        if (positionLines[k]) candleSeries.removePriceLine(positionLines[k]);
    });
    position = null;
    positionLines = { entry: null, tp: null, sl: null, bid: null, ask: null };
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
    allData = await loadCSV(tf);

    const afterBuffer = 5 * 24 * 60 * 60; // 5 روز آینده
    const tfSeconds = { '1': 60, '5': 300, '15': 900 }[tf];
    const threeDaysSec = 5 * 24 * 60 * 60;

    if (!syncedTime) {
        const minTime = allData[0].time + threeDaysSec;
        const maxTime = allData[allData.length - 1].time - threeDaysSec;
        const randomTime = Math.floor(Math.random() * (maxTime - minTime)) + minTime;
        syncedTime = randomTime;
    }

    const anchorTime = syncedTime;
    const startTime = anchorTime - threeDaysSec;

    fullData = allData.filter(d => d.time >= startTime && d.time <= anchorTime + afterBuffer);

    visibleStartIndex = 0;
    currentIndex = fullData.length - 1;

    // پیدا کردن ایندکس دقیق برای syncedTime یا اولین کندل بعدش
    let exactIndex = fullData.findIndex(d => d.time === syncedTime);
    if (exactIndex === -1) {
        exactIndex = fullData.findIndex(d => d.time > syncedTime);
        if (exactIndex !== -1) {
            syncedTime = fullData[exactIndex].time;
        } else {
            exactIndex = 0;
            syncedTime = fullData[0].time;
        }
    }
    currentIndex = exactIndex;

    renderChart();
    updateChart();

    // ⛳ فقط بار اول یک کندل جلو برو
    if (isFirstLoad) {
        nextCandle();
        isFirstLoad = false;
    }
}


function redrawPositionLines() {
    if (!position || position.closed) return;

    positionLines.entry = candleSeries.createPriceLine({ price: position.entryPrice, color: 'gray', lineWidth: 1, title: 'Entry' });
    if (position.tp)
        positionLines.tp = candleSeries.createPriceLine({ price: position.tp, color: 'green', lineWidth: 1, title: 'TP' });
    positionLines.sl = candleSeries.createPriceLine({ price: position.sl, color: 'red', lineWidth: 1, title: 'SL' });

    const bid = position.type === 'buy' ? position.entryPrice - spread : position.entryPrice;
    const ask = position.type === 'buy' ? position.entryPrice : position.entryPrice + spread;

    positionLines.bid = candleSeries.createPriceLine({ price: bid, color: 'blue', lineWidth: 1, title: 'Bid' });
    positionLines.ask = candleSeries.createPriceLine({ price: ask, color: 'purple', lineWidth: 1, title: 'Ask' });
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
