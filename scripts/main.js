let chart, candleSeries, emaSeries;
let fullData = [], currentIndex = 0, intervalId = null;
let currentTf = '1', emaEnabled = false;
let positions = []; // ← به جای position
let positionLinesMap = new Map(); // ← برای خطوط هر پوزیشن
//let position = null;
let positionLines = { entry: null, tp: null, sl: null };
let balance = 10000, equity = 10000;
let syncedTime = null;
let allData = [];
let visibleStartIndex = 0;
let isFirstLoad = true;
let playSpeed = 1;
const speedOptions = [1, 2, 4, 10];
let userScrolled = false;
let closedPositions = [];



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

    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
        const logicalRange = chart.timeScale().getVisibleLogicalRange();
        const dataLength = fullData.length;
        if (!logicalRange) return;

        const isAtEnd = logicalRange.to >= dataLength - 2;
        userScrolled = !isAtEnd;
    });


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
    if (!userScrolled) {
        setTimeout(() => {
            try {
                chart.timeScale().scrollToPosition(Infinity, false);
            } catch (e) {
                console.warn('scrollToPosition failed:', e);
            }
        }, 0);
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
        }, 500 / playSpeed);
    }
}

function cycleSpeed() {
    const index = speedOptions.indexOf(playSpeed);
    const nextIndex = (index + 1) % speedOptions.length;
    playSpeed = speedOptions[nextIndex];

    document.getElementById("speedBtn").textContent = `×${playSpeed}`;

    if (intervalId) {
        // اگر در حالت پخش هستیم، پخش رو با سرعت جدید ری‌استارت کن
        pause();
        play();
    }
}


function pause() {
    clearInterval(intervalId);
    intervalId = null;
}

function openPosition(type) {
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
    const commissionExit = commissionEntry; // چون مشابهه
    const totalCommission = commissionEntry + commissionExit;

    const position = {
        id: Date.now() + Math.random(), // Unique ID
        type, entryPrice: entry, tp, sl, size,
        risk: riskAmount, commission: totalCommission,
        entryTime: nextCandle.time, closed: false
    };

    positions.push(position);
    drawPositionLines(position);
    updateEquity(nextCandle);
    renderPositionsTable();
}


function checkPosition(candle) {
    for (let position of positions) {
        if (position.closed) continue;

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
            removePositionLines(position);
            position.exitPrice = exit;
            position.pnl = pnl;
            closedPositions.push({
                ...position,
                pnl,
                commission: position.commission + commissionExit,
                exitPrice: exit,
            });

        }
    }

    updateEquity(candle);
    renderPositionsTable();
    renderStatementTable();
}


function updateEquity(candle) {
    let floatingTotal = 0;

    for (let position of positions) {
        if (position.closed) continue;

        const diff = position.type === 'buy'
            ? candle.close - position.entryPrice
            : position.entryPrice - candle.close;

        const floating = diff * position.size;
        const commissionExit = commissionPerLot * (position.size / contractSize);
        const netFloating = floating - commissionExit;

        position.floating = netFloating; // 👈 ذخیره در خود پوزیشن
        floatingTotal += netFloating;
    }

    equity = balance + floatingTotal;
    document.getElementById('floating').textContent = floatingTotal.toFixed(2);
    updateMetrics();
}


function drawPositionLines(position) {
    const lines = {};

    lines.entry = candleSeries.createPriceLine({ price: position.entryPrice, color: 'gray', lineWidth: 1, title: 'Entry' });
    if (position.tp)
        lines.tp = candleSeries.createPriceLine({ price: position.tp, color: 'green', lineWidth: 1, title: 'TP' });
    lines.sl = candleSeries.createPriceLine({ price: position.sl, color: 'red', lineWidth: 1, title: 'SL' });

    const bid = position.type === 'buy' ? position.entryPrice - spread : position.entryPrice;
    const ask = position.type === 'buy' ? position.entryPrice : position.entryPrice + spread;
    lines.bid = candleSeries.createPriceLine({ price: bid, color: 'blue', lineWidth: 1, title: 'Bid' });
    lines.ask = candleSeries.createPriceLine({ price: ask, color: 'purple', lineWidth: 1, title: 'Ask' });

    positionLinesMap.set(position.id, lines);
}

function removePositionLines(position) {
    const lines = positionLinesMap.get(position.id);
    if (lines) {
        Object.values(lines).forEach(line => candleSeries.removePriceLine(line));
        positionLinesMap.delete(position.id);
    }
}

function closePosition(id) {
    const posIndex = positions.findIndex(p => p.id === id);
    if (posIndex === -1) return;

    const pos = positions[posIndex];
    if (pos.closed) return;

    const candle = fullData[currentIndex];
    const exit = candle.close;

    let pnl = (pos.type === 'buy')
        ? (exit - pos.entryPrice) * pos.size
        : (pos.entryPrice - exit) * pos.size;

    const commissionExit = commissionPerLot * (pos.size / contractSize);
    pnl -= commissionExit;

    balance += pnl;
    equity = balance;
    pos.closed = true;

    clearPositionLines(id);
    updateMetrics();
    updatePositionTable();
}


function clearPosition() {
    ['entry', 'tp', 'sl', 'bid', 'ask'].forEach(k => {
        if (positionLines[k]) candleSeries.removePriceLine(positionLines[k]);
    });
    position = null;
    positionLines = { entry: null, tp: null, sl: null, bid: null, ask: null };
}

function renderPositionsTable() {
    const tbody = document.getElementById('positionTable');
    tbody.innerHTML = '';

    for (let pos of positions) {
        if (pos.closed) continue;

        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${pos.type.toUpperCase()}</td>
            <td>${pos.entryPrice.toFixed(2)}</td>
            <td>${pos.size.toFixed(2)}</td>
            <td>${pos.tp ? pos.tp.toFixed(2) : '-'}</td>
            <td>${pos.sl.toFixed(2)}</td>
            <td>${pos.floating !== undefined ? pos.floating.toFixed(2) : '--'}</td>
            <td><button onclick="manualClose('${pos.id}')">Close</button></td>
        `;
        tbody.appendChild(row);
    }
}


function formatTimestamp(ts) {
    const d = new Date(ts * 1000); // تبدیل از یونیکس (ثانیه) به تاریخ JS
    const y = d.getFullYear();
    const m = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    const h = d.getHours().toString().padStart(2, '0');
    const min = d.getMinutes().toString().padStart(2, '0');
    return `${y}-${m}-${day} ${h}:${min}`;
}


function renderStatementTable() {
    const tbody = document.getElementById('statementTable');
    if (!tbody) return;
    tbody.innerHTML = '';

    for (let p of closedPositions) {
        if (!p || !p.type) continue;

        const result = p.pnl >= 0 ? 'Profit' : 'Loss';

        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${p.type.toUpperCase()}</td>
            <td>${p.entryPrice.toFixed(2)}</td>
            <td>${p.exitPrice ? p.exitPrice.toFixed(2) : '--'}</td>
            <td>${p.size.toFixed(2)}</td>
            <td>${p.tp ? p.tp.toFixed(2) : '-'}</td>
            <td>${p.sl.toFixed(2)}</td>
            <td>${p.pnl?.toFixed(2) || '--'}</td>
            <td>${p.commission.toFixed(2)}</td>
            <td>${result}</td>
        `;
        tbody.appendChild(row);
    }
}




function manualClose(id) {
    console.log("Trying to close ID:", id);
    const pos = positions.find(p => p.id == id && !p.closed);
    if (!pos) {
        console.warn("Position not found or already closed for ID:", id);
        return;
    }

    const candle = fullData[currentIndex];
    const exit = candle.close;

    let pnl = (pos.type === 'buy')
        ? (exit - pos.entryPrice) * pos.size
        : (pos.entryPrice - exit) * pos.size;

    const commissionExit = commissionPerLot * (pos.size / contractSize);
    pnl -= commissionExit;

    balance += pnl;
    equity = balance;
    pos.closed = true;

    removePositionLines(pos);
    updateMetrics();
    renderPositionsTable();

    console.log("Manual close completed for ID:", id);
    pos.exitPrice = exit;
    pos.pnl = pnl;

    closedPositions.push({
        ...pos,
        pnl,
        commission: pos.commission + commissionExit,
        exitPrice: exit,
    });

    renderStatementTable();

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
    positions.forEach(pos => {
        if (pos.closed) return;
        drawPositionLines(pos);
    });
}

function togglePlayPause() {
    const btn = document.getElementById("playPauseBtn");
    if (intervalId) {
        pause();
        btn.textContent = "▶";
    } else {
        play();
        btn.textContent = "⏸";
    }
}

function showTab(tabId) {
    const tabs = document.querySelectorAll('.tab-content');
    const buttons = document.querySelectorAll('.tab-btn');

    tabs.forEach(t => t.classList.remove('active'));
    buttons.forEach(b => b.classList.remove('active'));

    document.getElementById(tabId).classList.add('active');
    event.target.classList.add('active');
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
window.togglePlayPause = togglePlayPause;
window.cycleSpeed = cycleSpeed;
window.manualClose = manualClose;
window.showTab = function (tabName) {
    const tabs = ['positions', 'statement'];
    tabs.forEach(tab => {
        document.getElementById(tab).style.display = (tab === tabName) ? 'block' : 'none';
        const btn = document.querySelector(`.tab-btn[onclick="showTab('${tab}')"]`);
        if (btn) btn.classList.toggle('active', tab === tabName);
    });
}


