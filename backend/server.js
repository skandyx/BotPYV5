
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import session from 'express-session';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import http from 'http';
import fetch from 'node-fetch';
import { ScannerService } from './ScannerService.js';
import { RealtimeAnalyzerService } from './RealtimeAnalyzerService.js';
import { TradingEngineService } from './TradingEngineService.js';
import { BollingerBands } from 'technicalindicators';


// --- Basic Setup ---
dotenv.config();
const app = express();
const port = process.env.PORT || 8080;
const server = http.createServer(app);

app.use(cors({
    origin: (origin, callback) => {
        callback(null, true);
    },
    credentials: true,
}));
app.use(bodyParser.json());
app.set('trust proxy', 1); // For Nginx

// --- Session Management ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'a_much_more_secure_and_random_secret_string_32_chars_long',
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24
    }
}));

// --- WebSocket Server for Frontend Communication ---
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();
server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    
    if (url.pathname === '/ws') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});
wss.on('connection', (ws) => {
    clients.add(ws);
    log('WEBSOCKET', 'Frontend client connected.');

    if (botState.fearAndGreed) {
        ws.send(JSON.stringify({ type: 'FEAR_AND_GREED_UPDATE', payload: botState.fearAndGreed }));
    }

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            if (data.type === 'GET_FULL_SCANNER_LIST') {
                log('WEBSOCKET', 'Client requested full scanner list. Sending...');
                ws.send(JSON.stringify({ type: 'FULL_SCANNER_LIST', payload: botState.scannerCache }));
            }
        } catch (e) {
            log('ERROR', `Failed to parse message from client: ${message}`);
        }
    });
    ws.on('close', () => {
        clients.delete(ws);
        log('WEBSOCKET', 'Frontend client disconnected.');
    });
    ws.on('error', (error) => {
        log('ERROR', `WebSocket client error: ${error.message}`);
        ws.close();
    });
});
function broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
             client.send(data, (err) => {
                if (err) log('ERROR', `Failed to send message to a client: ${err.message}`);
            });
        }
    }
}

// --- Logging Service ---
const log = (level, message) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${message}`);
    broadcast({ type: 'LOG_ENTRY', payload: { timestamp, level, message }});
};

// --- Binance API Client ---
class BinanceApiClient {
    constructor(apiKey, secretKey, log) {
        this.apiKey = apiKey;
        this.secretKey = secretKey;
        this.baseUrl = 'https://api.binance.com';
        this.log = log;
    }

    _getSignature(queryString) {
        return crypto.createHmac('sha256', this.secretKey).update(queryString).digest('hex');
    }

    async _request(method, endpoint, params = {}) {
        const timestamp = Date.now();
        let queryString = new URLSearchParams({ ...params, timestamp }).toString();
        const signature = this._getSignature(queryString);
        queryString += `&signature=${signature}`;
        const url = `${this.baseUrl}${endpoint}?${queryString}`;

        try {
            const response = await fetch(url, {
                method,
                headers: { 'X-MBX-APIKEY': this.apiKey }
            });
            if (response.status === 204 || response.status === 200 && response.headers.get('content-length') === '0') return {};
            const data = await response.json();
            if (!response.ok) throw new Error(`Binance API Error: ${data.msg || `HTTP ${response.status}`}`);
            this.log('BINANCE_API', `[${method}] ${endpoint} successful.`);
            return data;
        } catch (error) {
            this.log('ERROR', `[BINANCE_API] [${method}] ${endpoint} failed: ${error.message}`);
            throw error;
        }
    }
    
    async getAccountInfo() { return this._request('GET', '/api/v3/account'); }
    async createOrder(params) { return this._request('POST', '/api/v3/order', params); }
    
    async getExchangeInfo() {
        try {
            const response = await fetch(`${this.baseUrl}/api/v3/exchangeInfo`);
            const data = await response.json();
            this.log('BINANCE_API', `Successfully fetched exchange info for ${data.symbols.length} symbols.`);
            return data;
        } catch (error) {
             this.log('ERROR', `[BINANCE_API] Failed to fetch exchange info: ${error.message}`);
             throw error;
        }
    }
}
let binanceApiClient = null;
let symbolRules = new Map();

// --- Persistence & Auth ---
const DATA_DIR = path.join(process.cwd(), 'data');
const SETTINGS_FILE_PATH = path.join(DATA_DIR, 'settings.json');
const STATE_FILE_PATH = path.join(DATA_DIR, 'state.json');
const AUTH_FILE_PATH = path.join(DATA_DIR, 'auth.json');
const KLINE_DATA_DIR = path.join(DATA_DIR, 'klines');

const ensureDataDirs = async () => {
    try { await fs.access(DATA_DIR); } catch { await fs.mkdir(DATA_DIR); }
    try { await fs.access(KLINE_DATA_DIR); } catch { await fs.mkdir(KLINE_DATA_DIR); }
};

const hashPassword = (password) => new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, key) => err ? reject(err) : resolve(`${salt}:${key.toString('hex')}`));
});

const verifyPassword = (password, hash) => new Promise((resolve, reject) => {
    if (!hash || typeof hash !== 'string') return resolve(false);
    const parts = hash.split(':');
    if (parts.length !== 2) return resolve(false);
    const [salt, key] = parts;
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
        if (err) return reject(err);
        try {
            resolve(crypto.timingSafeEqual(Buffer.from(key, 'hex'), derivedKey));
        } catch {
            resolve(false);
        }
    });
});

// --- Bot State & Core Logic ---
let botState = {
    settings: {}, balance: 10000, activePositions: [], tradeHistory: [], tradeIdCounter: 1,
    scannerCache: [], isRunning: true, tradingMode: 'VIRTUAL', passwordHash: '',
    recentlyLostSymbols: new Map(), hotlist: new Set(), pendingConfirmation: new Map(),
    priceCache: new Map(), circuitBreakerStatus: 'NONE', dayStartBalance: 10000,
    dailyPnl: 0, consecutiveLosses: 0, consecutiveWins: 0,
    currentTradingDay: new Date().toISOString().split('T')[0], fearAndGreed: null,
};

const loadData = async () => {
    await ensureDataDirs();
    try {
        const settingsContent = await fs.readFile(SETTINGS_FILE_PATH, 'utf-8');
        botState.settings = JSON.parse(settingsContent);
    } catch {
        log("WARN", "settings.json not found. Loading from .env defaults.");
        
        const isNotFalse = (envVar) => process.env[envVar] !== 'false';
        const isTrue = (envVar) => process.env[envVar] === 'true';

        botState.settings = {
            INITIAL_VIRTUAL_BALANCE: parseFloat(process.env.INITIAL_VIRTUAL_BALANCE) || 10000,
            MAX_OPEN_POSITIONS: parseInt(process.env.MAX_OPEN_POSITIONS, 10) || 5,
            POSITION_SIZE_PCT: parseFloat(process.env.POSITION_SIZE_PCT) || 2.0,
            RISK_REWARD_RATIO: parseFloat(process.env.RISK_REWARD_RATIO) || 4.0,
            STOP_LOSS_PCT: parseFloat(process.env.STOP_LOSS_PCT) || 2.0,
            SLIPPAGE_PCT: parseFloat(process.env.SLIPPAGE_PCT) || 0.05,
            MIN_VOLUME_USD: parseFloat(process.env.MIN_VOLUME_USD) || 40000000,
            SCANNER_DISCOVERY_INTERVAL_SECONDS: parseInt(process.env.SCANNER_DISCOVERY_INTERVAL_SECONDS, 10) || 3600,
            EXCLUDED_PAIRS: process.env.EXCLUDED_PAIRS || "USDCUSDT,FDUSDUSDT,TUSDUSDT,BUSDUSDT",
            LOSS_COOLDOWN_HOURS: parseInt(process.env.LOSS_COOLDOWN_HOURS, 10) || 4,
            BINANCE_API_KEY: process.env.BINANCE_API_KEY || '',
            BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY || '',
            USE_ATR_STOP_LOSS: isNotFalse('USE_ATR_STOP_LOSS'),
            ATR_MULTIPLIER: parseFloat(process.env.ATR_MULTIPLIER) || 1.5,
            USE_AUTO_BREAKEVEN: isNotFalse('USE_AUTO_BREAKEVEN'),
            BREAKEVEN_TRIGGER_R: parseFloat(process.env.BREAKEVEN_TRIGGER_R) || 1.0,
            ADJUST_BREAKEVEN_FOR_FEES: isNotFalse('ADJUST_BREAKEVEN_FOR_FEES'),
            TRANSACTION_FEE_PCT: parseFloat(process.env.TRANSACTION_FEE_PCT) || 0.1,
            USE_RSI_SAFETY_FILTER: isNotFalse('USE_RSI_SAFETY_FILTER'),
            RSI_OVERBOUGHT_THRESHOLD: parseInt(process.env.RSI_OVERBOUGHT_THRESHOLD, 10) || 75,
            USE_PARABOLIC_FILTER: isNotFalse('USE_PARABOLIC_FILTER'),
            PARABOLIC_FILTER_PERIOD_MINUTES: parseInt(process.env.PARABOLIC_FILTER_PERIOD_MINUTES, 10) || 5,
            PARABOLIC_FILTER_THRESHOLD_PCT: parseFloat(process.env.PARABOLIC_FILTER_THRESHOLD_PCT) || 2.5,
            USE_VOLUME_CONFIRMATION: isNotFalse('USE_VOLUME_CONFIRMATION'),
            USE_MARKET_REGIME_FILTER: isNotFalse('USE_MARKET_REGIME_FILTER'),
            USE_PARTIAL_TAKE_PROFIT: isTrue('USE_PARTIAL_TAKE_PROFIT'),
            PARTIAL_TP_TRIGGER_PCT: parseFloat(process.env.PARTIAL_TP_TRIGGER_PCT) || 0.8,
            PARTIAL_TP_SELL_QTY_PCT: parseInt(process.env.PARTIAL_TP_SELL_QTY_PCT, 10) || 50,
            USE_DYNAMIC_POSITION_SIZING: isTrue('USE_DYNAMIC_POSITION_SIZING'),
            STRONG_BUY_POSITION_SIZE_PCT: parseFloat(process.env.STRONG_BUY_POSITION_SIZE_PCT) || 3.0,
            REQUIRE_STRONG_BUY: isTrue('REQUIRE_STRONG_BUY'),
            USE_DYNAMIC_PROFILE_SELECTOR: isNotFalse('USE_DYNAMIC_PROFILE_SELECTOR'),
            ADX_THRESHOLD_RANGE: parseInt(process.env.ADX_THRESHOLD_RANGE, 10) || 20,
            ATR_PCT_THRESHOLD_VOLATILE: parseFloat(process.env.ATR_PCT_THRESHOLD_VOLATILE) || 5.0,
            USE_AGGRESSIVE_ENTRY_LOGIC: isTrue('USE_AGGRESSIVE_ENTRY_LOGIC'),
            USE_ADAPTIVE_TRAILING_STOP: isNotFalse('USE_ADAPTIVE_TRAILING_STOP'),
            TRAILING_STOP_TIGHTEN_THRESHOLD_R: parseFloat(process.env.TRAILING_STOP_TIGHTEN_THRESHOLD_R) || 1.0,
            TRAILING_STOP_TIGHTEN_MULTIPLIER_REDUCTION: parseFloat(process.env.TRAILING_STOP_TIGHTEN_MULTIPLIER_REDUCTION) || 0.3,
            CIRCUIT_BREAKER_WARN_THRESHOLD_PCT: parseFloat(process.env.CIRCUIT_BREAKER_WARN_THRESHOLD_PCT) || 1.5,
            CIRCUIT_BREAKER_HALT_THRESHOLD_PCT: parseFloat(process.env.CIRCUIT_BREAKER_HALT_THRESHOLD_PCT) || 2.5,
            DAILY_DRAWDOWN_LIMIT_PCT: parseFloat(process.env.DAILY_DRAWDOWN_LIMIT_PCT) || 3.0,
            CONSECUTIVE_LOSS_LIMIT: parseInt(process.env.CONSECUTIVE_LOSS_LIMIT, 10) || 5,
            USE_MTF_VALIDATION: isTrue('USE_MTF_VALIDATION'),
            USE_OBV_VALIDATION: isNotFalse('USE_OBV_VALIDATION'),
            USE_CVD_FILTER: isTrue('USE_CVD_FILTER'),
            USE_RSI_MTF_FILTER: isTrue('USE_RSI_MTF_FILTER'),
            RSI_15M_OVERBOUGHT_THRESHOLD: parseInt(process.env.RSI_15M_OVERBOUGHT_THRESHOLD, 10) || 70,
            USE_WICK_DETECTION_FILTER: isTrue('USE_WICK_DETECTION_FILTER'),
            MAX_UPPER_WICK_PCT: parseFloat(process.env.MAX_UPPER_WICK_PCT) || 50,
            USE_OBV_5M_VALIDATION: isTrue('USE_OBV_5M_VALIDATION'),
            SCALING_IN_CONFIG: process.env.SCALING_IN_CONFIG || "50,50",
            MAX_CORRELATED_TRADES: parseInt(process.env.MAX_CORRELATED_TRADES, 10) || 2,
            USE_FEAR_AND_GREED_FILTER: isTrue('USE_FEAR_AND_GREED_FILTER'),
            USE_ORDER_BOOK_LIQUIDITY_FILTER: isTrue('USE_ORDER_BOOK_LIQUIDITY_FILTER'),
            MIN_ORDER_BOOK_LIQUIDITY_USD: parseInt(process.env.MIN_ORDER_BOOK_LIQUIDITY_USD, 10) || 200000,
            USE_SECTOR_CORRELATION_FILTER: isTrue('USE_SECTOR_CORRELATION_FILTER'),
            USE_WHALE_MANIPULATION_FILTER: isTrue('USE_WHALE_MANIPULATION_FILTER'),
            WHALE_SPIKE_THRESHOLD_PCT: parseFloat(process.env.WHALE_SPIKE_THRESHOLD_PCT) || 5.0,
            USE_IGNITION_STRATEGY: isTrue('USE_IGNITION_STRATEGY'),
            IGNITION_PRICE_SPIKE_PCT: parseFloat(process.env.IGNITION_PRICE_SPIKE_PCT) || 5.0,
            IGNITION_VOLUME_MULTIPLE: parseInt(process.env.IGNITION_VOLUME_MULTIPLE, 10) || 10,
        };
        await saveData('settings');
    }
    try {
        const stateContent = await fs.readFile(STATE_FILE_PATH, 'utf-8');
        const persistedState = JSON.parse(stateContent);
        Object.assign(botState, persistedState);
        if (!botState.balance) botState.balance = botState.settings.INITIAL_VIRTUAL_BALANCE;
        if (!botState.dayStartBalance) botState.dayStartBalance = botState.balance;
    } catch {
        log("WARN", "state.json not found. Initializing default state.");
        botState.balance = botState.settings.INITIAL_VIRTUAL_BALANCE;
        botState.dayStartBalance = botState.settings.INITIAL_VIRTUAL_BALANCE;
        await saveData('state');
    }
    try {
        const authContent = await fs.readFile(AUTH_FILE_PATH, 'utf-8');
        botState.passwordHash = JSON.parse(authContent).passwordHash;
    } catch {
        log("WARN", "auth.json not found. Initializing from .env.");
        const initialPassword = process.env.APP_PASSWORD;
        if (!initialPassword) {
            log('ERROR', 'CRITICAL: APP_PASSWORD is not set. Please set it and restart.');
            process.exit(1);
        }
        botState.passwordHash = await hashPassword(initialPassword);
        await saveData('auth');
    }

    if (botState.settings.BINANCE_API_KEY && botState.settings.BINANCE_SECRET_KEY) {
        binanceApiClient = new BinanceApiClient(botState.settings.BINANCE_API_KEY, botState.settings.BINANCE_SECRET_KEY, log);
        try {
            const exchangeInfo = await binanceApiClient.getExchangeInfo();
            exchangeInfo.symbols.forEach(s => {
                const stepSizeFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
                if (stepSizeFilter) {
                    symbolRules.set(s.symbol, { stepSize: parseFloat(stepSizeFilter.stepSize) });
                }
            });
        } catch (error) {
            log('ERROR', `Could not initialize Binance symbol rules: ${error.message}`);
        }
    }
    realtimeAnalyzer.updateSettings(botState.settings);
    tradingEngine.updateSettings(botState.settings);
};

const saveData = async (type) => {
    await ensureDataDirs();
    if (type === 'settings') {
        await fs.writeFile(SETTINGS_FILE_PATH, JSON.stringify(botState.settings, null, 2));
    } else if (type === 'state') {
        const { settings, passwordHash, scannerCache, ...stateToSave } = botState;
        await fs.writeFile(STATE_FILE_PATH, JSON.stringify(stateToSave, null, 2));
    } else if (type === 'auth') {
        await fs.writeFile(AUTH_FILE_PATH, JSON.stringify({ passwordHash: botState.passwordHash }, null, 2));
    }
};

const scanner = new ScannerService(log, KLINE_DATA_DIR);
const realtimeAnalyzer = new RealtimeAnalyzerService(log);
const tradingEngine = new TradingEngineService(botState, log, broadcast, saveData, binanceApiClient, symbolRules);
let scannerInterval = null;

const runScannerCycle = async () => {
    log('SCANNER', 'Running discovery scan cycle...');
    try {
        const discoveredPairs = await scanner.runScan(botState.settings);
        const hydratedPairs = await Promise.all(
            discoveredPairs.map(p => realtimeAnalyzer.hydrateSymbol(p.symbol, p))
        );
        botState.scannerCache = hydratedPairs.filter(Boolean);
        log('SCANNER', `Scanner cache updated with ${botState.scannerCache.length} pairs.`);
        updateBinanceSubscriptions();
    } catch (error) {
        log('ERROR', `Scanner cycle failed: ${error.message}`);
    }
};

// --- Binance WebSocket ---
let binanceWs = null;
const connectToBinanceStreams = () => {
    if (binanceWs) binanceWs.close();
    
    const streams = ['!ticker@arr']; // All tickers for price updates
    const klineStreams = ['1m', '5m', '15m'].map(tf => `@kline_${tf}`);
    const allStreams = streams.concat(botState.scannerCache.map(p => p.symbol.toLowerCase()).flatMap(s => klineStreams.map(k => `${s}${k}`)));
    
    if (allStreams.length <= 1) {
        log('WARN', 'No symbols in scanner cache, connecting to tickers only.');
    }
    
    const url = `wss://stream.binance.com:9443/stream?streams=${allStreams.join('/')}`;
    binanceWs = new WebSocket(url);
    
    binanceWs.on('open', () => log('BINANCE_WS', `Connected to ${allStreams.length} streams.`));
    binanceWs.on('message', handleBinanceMessage);
    binanceWs.on('close', () => {
        log('WARN', 'Binance WebSocket disconnected. Reconnecting in 5s...');
        setTimeout(connectToBinanceStreams, 5000);
    });
    binanceWs.on('error', (err) => log('ERROR', `Binance WebSocket error: ${err.message}`));
};

const handleBinanceMessage = (data) => {
    try {
        const { stream, data: payload } = JSON.parse(data);
        if (stream === '!ticker@arr') {
            payload.forEach(ticker => {
                botState.priceCache.set(ticker.s, { price: parseFloat(ticker.c) });
                broadcast({ type: 'PRICE_UPDATE', payload: { symbol: ticker.s, price: parseFloat(ticker.c) } });
            });
            tradingEngine.checkAllPositions();
        } else if (payload.e === 'kline') {
            const { s: symbol, k: kline } = payload;
            const isClosed = kline.x;
            if(isClosed) {
                realtimeAnalyzer.handleNewKline(symbol, kline.i, kline).then(updatedPair => {
                    if(updatedPair) {
                        const cacheIndex = botState.scannerCache.findIndex(p => p.symbol === symbol);
                        if (cacheIndex !== -1) botState.scannerCache[cacheIndex] = updatedPair;
                        else botState.scannerCache.push(updatedPair);
                        
                        broadcast({ type: 'SCANNER_UPDATE', payload: updatedPair });
                        tradingEngine.evaluateSignal(updatedPair);
                    }
                });
            }
        }
    } catch(e) {
        log('ERROR', `Failed to process Binance WS message: ${e.message}`);
    }
};

const updateBinanceSubscriptions = () => {
    log('BINANCE_WS', 'Updating Binance stream subscriptions...');
    connectToBinanceStreams(); // Reconnect with new list
};


// --- Backtesting Engine ---
function performStrategyBacktest(klines) {
    const bbLen = 20;
    const bbMult = 2.0;
    const slPct = 3.0;
    const initialCapital = 10000;

    let capital = initialCapital;
    let position = null;
    let trades = [];
    let equityCurve = [initialCapital];
    let peakEquity = initialCapital;
    let maxDrawdown = 0;

    const closes = klines.map(k => k.close);
    const bb = BollingerBands.calculate({ period: bbLen, values: closes, stdDev: bbMult });

    for (let i = bbLen; i < klines.length; i++) {
        const currentCandle = klines[i];
        const prevCandle = klines[i-1];
        const currentBBIndex = i - bbLen + 1;
        const prevBBIndex = currentBBIndex - 1;
        
        if (prevBBIndex < 0 || currentBBIndex >= bb.length) continue;

        const currentBB = bb[currentBBIndex];
        const prevBB = bb[prevBBIndex];

        let currentEquity = capital + (position ? position.quantity * currentCandle.close : 0);

        if (position) {
            let exit = false;
            let exitPrice = 0;

            if (currentCandle.high >= currentBB.upper) {
                exit = true;
                exitPrice = currentBB.upper;
            }

            if (currentCandle.low <= position.stopLossPrice) {
                if (!exit || position.stopLossPrice < exitPrice) exitPrice = position.stopLossPrice;
                exit = true;
            }

            if (exit) {
                capital += position.quantity * exitPrice;
                const pnl = (exitPrice - position.entryPrice) * position.quantity;
                trades.push({ pnl });
                position = null;
                currentEquity = capital;
            }
        }

        if (!position) {
            const candle_broke_lower = (currentCandle.close < currentBB.lower) && (prevCandle.close >= prevBB.lower);
            if (candle_broke_lower && currentCandle.close > 0) {
                const positionSize = currentEquity * 0.10;
                const quantity = positionSize / currentCandle.close;
                position = {
                    entryPrice: currentCandle.close,
                    quantity: quantity,
                    stopLossPrice: currentCandle.close * (1 - slPct / 100.0)
                };
            }
        }
        
        equityCurve.push(currentEquity);
        peakEquity = Math.max(peakEquity, currentEquity);
        const drawdown = ((peakEquity - currentEquity) / peakEquity) * 100;
        maxDrawdown = Math.max(maxDrawdown, drawdown);
    }

    const finalEquity = equityCurve[equityCurve.length - 1];
    const netProfitPct = ((finalEquity - initialCapital) / initialCapital) * 100;
    const winningTrades = trades.filter(t => t.pnl > 0);
    const totalProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
    const totalLoss = trades.filter(t => t.pnl <= 0).reduce((sum, t) => sum + Math.abs(t.pnl), 0);
    const winRate = trades.length > 0 ? (winningTrades.length / trades.length) * 100 : 0;
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? 9999 : 1);

    return {
        netProfitPct: isNaN(netProfitPct) ? 0 : netProfitPct,
        totalTrades: trades.length,
        winRate: isNaN(winRate) ? 0 : winRate,
        profitFactor: isNaN(profitFactor) ? 1 : profitFactor,
        maxDrawdownPct: isNaN(maxDrawdown) ? 0 : maxDrawdown,
    };
}

// --- API Endpoints ---
const isAuthenticated = (req, res, next) => {
    if (req.session.isAuthenticated) return next();
    res.status(401).json({ message: 'Not authenticated' });
};

app.post('/api/login', async (req, res) => {
    const { password } = req.body;
    try {
        const isMatch = await verifyPassword(password, botState.passwordHash);
        if (isMatch) {
            req.session.isAuthenticated = true;
            res.json({ success: true, message: "Login successful." });
        } else {
            res.status(401).json({ success: false, message: "Invalid password." });
        }
    } catch(e) {
        res.status(401).json({ success: false, message: "Invalid password." });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.status(204).send());
});

app.post('/api/change-password', isAuthenticated, async (req, res) => {
    const { newPassword } = req.body;
    if(!newPassword || newPassword.length < 8) {
        return res.status(400).json({ success: false, message: "Password must be at least 8 characters long." });
    }
    botState.passwordHash = await hashPassword(newPassword);
    await saveData('auth');
    res.json({ success: true, message: "Password updated successfully." });
});

app.get('/api/check-session', (req, res) => {
    res.json({ isAuthenticated: !!req.session.isAuthenticated });
});

app.get('/api/settings', isAuthenticated, (req, res) => res.json(botState.settings));
app.post('/api/settings', isAuthenticated, async (req, res) => {
    botState.settings = { ...botState.settings, ...req.body };
    realtimeAnalyzer.updateSettings(botState.settings);
    tradingEngine.updateSettings(botState.settings);
    if(botState.settings.BINANCE_API_KEY && botState.settings.BINANCE_SECRET_KEY) {
        tradingEngine.updateApiClient(new BinanceApiClient(botState.settings.BINANCE_API_KEY, botState.settings.BINANCE_SECRET_KEY, log));
    }
    await saveData('settings');
    res.json({ success: true });
});

app.get('/api/status', isAuthenticated, (req, res) => res.json({
    mode: botState.tradingMode,
    balance: botState.balance,
    positions: botState.activePositions.length,
    monitored_pairs: botState.scannerCache.length,
    top_pairs: botState.scannerCache.slice(0, 10).map(p => p.symbol),
    max_open_positions: botState.settings.MAX_OPEN_POSITIONS,
}));

app.get('/api/positions', isAuthenticated, (req, res) => res.json(botState.activePositions));
app.get('/api/history', isAuthenticated, (req, res) => res.json(botState.tradeHistory));
app.get('/api/scanner', isAuthenticated, (req, res) => res.json(botState.scannerCache));

app.get('/api/performance-stats', isAuthenticated, (req, res) => {
    const closedTrades = botState.tradeHistory.filter(t => t.status === 'CLOSED');
    const total_pnl = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const winning_trades = closedTrades.filter(t => (t.pnl || 0) > 0).length;
    const total_trades = closedTrades.length;
    res.json({
        total_trades,
        winning_trades,
        losing_trades: total_trades - winning_trades,
        total_pnl,
        avg_pnl_pct: total_trades > 0 ? closedTrades.reduce((sum, t) => sum + (t.pnl_pct || 0), 0) / total_trades : 0,
        win_rate: total_trades > 0 ? (winning_trades / total_trades) * 100 : 0,
    });
});

app.post('/api/close-trade/:id', isAuthenticated, async (req, res) => {
    const tradeId = parseInt(req.params.id, 10);
    const price = botState.priceCache.get(botState.activePositions.find(p=>p.id === tradeId)?.symbol)?.price;
    const result = await tradingEngine.manualClose(tradeId, price);
    if(result.success) res.json(result.trade);
    else res.status(404).json({ message: result.message });
});

app.post('/api/clear-data', isAuthenticated, async (req, res) => {
    botState.activePositions = [];
    botState.tradeHistory = [];
    botState.balance = botState.settings.INITIAL_VIRTUAL_BALANCE;
    botState.dayStartBalance = botState.settings.INITIAL_VIRTUAL_BALANCE;
    botState.tradeIdCounter = 1;
    await saveData('state');
    broadcast({ type: 'POSITIONS_UPDATED' });
    res.json({ success: true });
});

app.post('/api/test-connection', isAuthenticated, async (req, res) => {
    const { apiKey, secretKey } = req.body;
    const testClient = new BinanceApiClient(apiKey, secretKey, ()=>{});
    try {
        await testClient.getAccountInfo();
        res.json({ success: true, message: "Connexion à Binance réussie."});
    } catch(e) {
        res.status(400).json({ success: false, message: `Échec de la connexion : ${e.message}`});
    }
});

app.get('/api/bot/status', isAuthenticated, (req, res) => res.json({ isRunning: botState.isRunning }));
app.post('/api/bot/start', isAuthenticated, (req, res) => { botState.isRunning = true; res.json({ success: true }); });
app.post('/api/bot/stop', isAuthenticated, (req, res) => { botState.isRunning = false; res.json({ success: true }); });
app.get('/api/mode', isAuthenticated, (req, res) => res.json({ mode: botState.tradingMode }));
app.post('/api/mode', isAuthenticated, (req, res) => {
    const { mode } = req.body;
    if (['VIRTUAL', 'REAL_PAPER', 'REAL_LIVE'].includes(mode)) {
        botState.tradingMode = mode;
        res.json({ success: true, mode });
    } else {
        res.status(400).json({ success: false, message: 'Invalid mode' });
    }
});

app.post('/api/backtest', isAuthenticated, async (req, res) => {
    const { symbols } = req.body;
    if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
        return res.status(400).json({ message: 'No symbols provided.' });
    }

    const timeframes = ['5m', '15m', '30m', '1h', '2h', '4h'];
    const allResults = [];
    log('INFO', `Starting backtest for ${symbols.length} symbols.`);

    for (const symbol of symbols) {
        for (const timeframe of timeframes) {
            try {
                const klines = await scanner.fetchKlinesFromBinance(symbol, timeframe, 0, 200);
                if (klines.length < 21) throw new Error(`Not enough data (${klines.length} candles).`);
                
                const formattedKlines = klines.map(k => ({
                    open: parseFloat(k[1]), high: parseFloat(k[2]),
                    low: parseFloat(k[3]), close: parseFloat(k[4]),
                    volume: parseFloat(k[5]),
                }));

                const result = performStrategyBacktest(formattedKlines);
                allResults.push({ symbol, timeframe, ...result });
            } catch (error) {
                log('ERROR', `Backtest failed for ${symbol} on ${timeframe}: ${error.message}`);
                allResults.push({ symbol, timeframe, netProfitPct: 0, totalTrades: 0, winRate: 0, profitFactor: 0, maxDrawdownPct: 0, error: error.message });
            }
        }
    }
    res.json(allResults);
});

// Serve frontend in production
if (process.env.NODE_ENV === 'production') {
    const clientBuildPath = path.join(process.cwd(), '..', 'dist');
    app.use(express.static(clientBuildPath));
    app.get('*', (req, res) => {
        res.sendFile(path.join(clientBuildPath, 'index.html'));
    });
}

// --- Server Initialization ---
const main = async () => {
    await loadData();
    scannerInterval = setInterval(runScannerCycle, botState.settings.SCANNER_DISCOVERY_INTERVAL_SECONDS * 1000);
    runScannerCycle();
    connectToBinanceStreams();

    setInterval(async () => {
        try {
            const response = await fetch('https://api.alternative.me/fng/?limit=1');
            const data = await response.json();
            botState.fearAndGreed = { value: parseInt(data.data[0].value), classification: data.data[0].value_classification };
            broadcast({ type: 'FEAR_AND_GREED_UPDATE', payload: botState.fearAndGreed });
        } catch(e) {
            log('WARN', `Could not fetch Fear & Greed index: ${e.message}`);
        }
    }, 1000 * 60 * 60); // Fetch every hour

    server.listen(port, () => {
        log('INFO', `Server listening on http://localhost:${port}`);
    });
};

main().catch(err => {
    log('ERROR', `Failed to start server: ${err.stack}`);
    process.exit(1);
});
