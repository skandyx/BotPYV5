
import { RSI, ADX, ATR, BollingerBands, EMA, OBV, SMA } from 'technicalindicators';
import { ScannerService } from './ScannerService.js';

const scanner = new ScannerService(() => {}); // Dummy log

function calculateCVD(klines) {
    if (!klines || klines.length === 0) return 0;
    let cvd = 0;
    klines.forEach(k => {
        const priceChange = k.close - k.open;
        if (priceChange > 0) cvd += k.volume;
        else if (priceChange < 0) cvd -= k.volume;
    });
    return cvd;
}

export class RealtimeAnalyzerService {
    constructor(log, getBotState) {
        this.log = log;
        this.getBotState = getBotState;
        this.settings = {};
        this.klineData = new Map();
    }

    updateSettings(settings) {
        this.settings = settings;
    }

    async hydrateSymbol(symbol, baseData) {
        try {
            const klines15m = await this.fetchKlines(symbol, '15m');
            if (klines15m.length < 50) return null;
            const analysis15m = this.analyzeTimeframe(klines15m, '15m');
            return { ...baseData, ...analysis15m };
        } catch (e) {
            this.log('WARN', `Failed to hydrate ${symbol}: ${e.message}`);
            return null;
        }
    }

    async handleNewKline(symbol, interval, kline) {
        const formattedKline = {
            open: parseFloat(kline.o), high: parseFloat(kline.h),
            low: parseFloat(kline.l), close: parseFloat(kline.c),
            volume: parseFloat(kline.v),
        };

        const key = `${symbol}_${interval}`;
        if (!this.klineData.has(key)) {
            const historicalKlines = await this.fetchKlines(symbol, interval, 200);
            this.klineData.set(key, historicalKlines);
        }
        
        const klines = this.klineData.get(key);
        klines.push(formattedKline);
        if (klines.length > 201) klines.shift();
        
        return this.runFullAnalysis(symbol);
    }

    async runFullAnalysis(symbol) {
        try {
            const [baseData, klines1m, klines5m, klines15m, klines1h, klines4h] = await Promise.all([
                this.getBaseData(symbol), this.fetchKlines(symbol, '1m'),
                this.fetchKlines(symbol, '5m'), this.fetchKlines(symbol, '15m'),
                this.fetchKlines(symbol, '1h'), this.fetchKlines(symbol, '4h'),
            ]);

            if (klines15m.length < 50 || klines1h.length < 21 || klines4h.length < 51 || klines1m.length < 21) return null;

            const analysis1m = this.analyzeTimeframe(klines1m, '1m');
            const analysis5m = this.analyzeTimeframe(klines5m, '5m');
            const analysis15m = this.analyzeTimeframe(klines15m, '15m');
            const analysis1h = this.analyzeTimeframe(klines1h, '1h');
            const analysis4h = this.analyzeTimeframe(klines4h, '4h');
            
            const combined = { symbol, price: baseData.price, volume: baseData.volume, priceDirection: 'neutral', ...analysis15m, ...analysis1h, ...analysis4h };
            return this.evaluateStrategy(combined, analysis1m, analysis5m, klines1m, klines15m);
        } catch (e) {
            this.log('ERROR', `Full analysis for ${symbol} failed: ${e.message}`);
            return null;
        }
    }

    analyzeTimeframe(klines, interval) {
        if (klines.length < 21) return {};
        const closes = klines.map(k => k.close);
        const highs = klines.map(k => k.high);
        const lows = klines.map(k => k.low);
        const volumes = klines.map(k => k.volume);
        const result = {};

        switch (interval) {
            case '1m':
                result.ema9_1m = EMA.calculate({ period: 9, values: closes }).pop();
                result.volume_avg_1m = SMA.calculate({ period: 20, values: volumes }).pop();
                result.obv_1m_slope = this.getObvSlope(klines);
                break;
            case '5m':
                result.cvd_5m_trending_up = this.getCvdSlope(klines) > 0;
                const lastCandle5m = klines[klines.length - 1];
                const avgVolume5m = SMA.calculate({ period: 20, values: volumes }).pop();
                result.momentum_confirmation_5m = lastCandle5m.close > lastCandle5m.open && lastCandle5m.volume > avgVolume5m;
                break;
            case '15m':
                const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
                const lastBB = bb[bb.length-1] || { upper: 0, middle: 0, lower: 0 };
                const bbWidths = bb.map(b => ((b.upper - b.lower) / b.middle) * 100).filter(v => !isNaN(v));
                const lastWidth = bbWidths[bbWidths.length-1];
                bbWidths.sort((a, b) => a - b);
                const squeezeThreshold = bbWidths[Math.floor(bbWidths.length * 0.25)];
                result.bollinger_bands_15m = { ...lastBB, width_pct: lastWidth };
                result.is_in_squeeze_15m = lastWidth < squeezeThreshold;
                result.rsi_15m = RSI.calculate({ period: 14, values: closes }).pop();
                result.adx_15m = ADX.calculate({ high, low, close: closes, period: 14 }).pop()?.adx;
                const atr = ATR.calculate({ high, low, close: closes, period: 14 }).pop();
                result.atr_15m = atr;
                result.atr_pct_15m = (atr / closes[closes.length - 1]) * 100;
                const lastCandle15m = klines[klines.length - 1];
                const avgVolume15m = SMA.calculate({ period: 20, values: volumes }).pop();
                const candleRange = lastCandle15m.high - lastCandle15m.low;
                const bodySize = Math.abs(lastCandle15m.close - lastCandle15m.open);
                result.momentum_impulse_15m = candleRange > 0 && (bodySize / candleRange > 0.7) && (lastCandle15m.volume > (avgVolume15m * 2)) && (lastCandle15m.close > lastCandle15m.open);
                break;
            case '1h':
                result.rsi_1h = RSI.calculate({ period: 14, values: closes }).pop();
                break;
            case '4h':
                result.price_above_ema50_4h = closes[closes.length - 1] > EMA.calculate({ period: 50, values: closes }).pop();
                break;
        }
        return result;
    }

    evaluateStrategy(pair, analysis1m, analysis5m, klines1m) {
        let conditions = { trend: false, squeeze: false, breakout: false, volume: false, safety: false, obv: false, rsi_mtf: false, cvd_5m_trending_up: false, momentum_impulse: false, momentum_confirmation: false };
        const shared = this.evaluateSharedConditions(pair, conditions);
        
        const ignitionResult = this.evaluateIgnitionStrategy(pair, klines1m, shared.conditions);
        const momentumResult = this.evaluateMomentumStrategy(pair, analysis5m, shared.conditions);
        const precisionResult = this.evaluatePrecisionStrategy(pair, analysis1m, analysis5m, klines1m, shared.conditions);

        let finalResult = precisionResult;
        if (momentumResult.score_value > finalResult.score_value) finalResult = momentumResult;
        if (ignitionResult.score_value > finalResult.score_value) finalResult = ignitionResult;
        
        let metCount = Object.values(finalResult.conditions).filter(c => c === true).length;
        
        pair.conditions = finalResult.conditions;
        pair.conditions_met_count = metCount;
        pair.score = finalResult.score;
        pair.score_value = finalResult.score_value;
        pair.strategy_type = finalResult.strategy_type;

        return pair;
    }

    evaluateSharedConditions(pair, conditions) {
        conditions.trend = pair.price_above_ema50_4h;
        conditions.safety = this.settings.USE_RSI_SAFETY_FILTER ? (pair.rsi_1h || 0) < this.settings.RSI_OVERBOUGHT_THRESHOLD : true;
        conditions.rsi_mtf = this.settings.USE_RSI_MTF_FILTER ? (pair.rsi_15m || 0) < this.settings.RSI_15M_OVERBOUGHT_THRESHOLD : true;
        return { conditions };
    }

    evaluateIgnitionStrategy(pair, klines1m, conditions) {
        let result = { score: 'HOLD', score_value: 0, strategy_type: 'IGNITION', conditions };
        if (this.settings.USE_IGNITION_STRATEGY && conditions.trend) {
            const lastCandle1m = klines1m[klines1m.length - 1];
            const prevCandle1m = klines1m[klines1m.length - 2];
            const avgVolume1m = SMA.calculate({ period: 20, values: klines1m.map(k=>k.volume) }).pop();
            if (lastCandle1m && prevCandle1m && avgVolume1m > 0) {
                const priceSpikePct = ((lastCandle1m.close - prevCandle1m.close) / prevCandle1m.close) * 100;
                const volumeMultiple = lastCandle1m.volume / avgVolume1m;
                if (priceSpikePct >= this.settings.IGNITION_PRICE_SPIKE_PCT && volumeMultiple >= this.settings.IGNITION_VOLUME_MULTIPLE) {
                    result.score = 'IGNITION_DETECTED';
                    result.score_value = 100;
                    this.log('SCANNER', `🚀 IGNITION DETECTED for ${pair.symbol}: Price Spike: ${priceSpikePct.toFixed(2)}%, Volume x${volumeMultiple.toFixed(1)}`);
                }
            }
        }
        return result;
    }
    
    evaluateMomentumStrategy(pair, analysis5m, conditions) {
        let result = { score: 'HOLD', score_value: 0, strategy_type: 'MOMENTUM', conditions: { ...conditions } };
        result.conditions.momentum_impulse = pair.momentum_impulse_15m;
        result.conditions.momentum_confirmation = analysis5m.momentum_confirmation_5m;

        if (conditions.trend && result.conditions.momentum_impulse && result.conditions.momentum_confirmation && conditions.safety && conditions.rsi_mtf) {
            result.score = 'MOMENTUM_BUY';
            result.score_value = 90;
        }
        return result;
    }

    evaluatePrecisionStrategy(pair, analysis1m, analysis5m, klines1m, conditions) {
        let result = { score: 'HOLD', score_value: 50, strategy_type: 'PRECISION', conditions: { ...conditions } };
        result.conditions.squeeze = pair.is_in_squeeze_15m;

        if (conditions.trend && result.conditions.squeeze) {
            pair.is_on_hotlist = true;
            result.score = 'COMPRESSION';
            result.score_value = 70;
            const lastCandle1m = klines1m[klines1m.length - 1];
            if (lastCandle1m) {
                result.conditions.breakout = lastCandle1m.close > (analysis1m.ema9_1m || 0);
                result.conditions.volume = this.settings.USE_VOLUME_CONFIRMATION ? lastCandle1m.volume > ((analysis1m.volume_avg_1m || 0) * 1.5) : true;
                result.conditions.obv = this.settings.USE_OBV_VALIDATION ? (analysis1m.obv_1m_slope || 0) > 0 : true;
                result.conditions.cvd_5m_trending_up = this.settings.USE_CVD_FILTER ? analysis5m.cvd_5m_trending_up : true;

                if (result.conditions.breakout && result.conditions.volume && result.conditions.obv && result.conditions.cvd_5m_trending_up && conditions.safety && conditions.rsi_mtf) {
                    result.score = 'PENDING_CONFIRMATION';
                    result.score_value = 80;
                }
            }
        } else {
            pair.is_on_hotlist = false;
        }
        return result;
    }

    async fetchKlines(symbol, interval, limit = 201) {
        const key = `${symbol}_${interval}`;
        const cachedKlines = this.klineData.get(key);
        if (cachedKlines && cachedKlines.length >= limit) return cachedKlines;
        
        const klines = await scanner.fetchKlinesFromBinance(symbol, interval, 0, limit);
        const formattedKlines = klines.map(k => ({ open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) }));
        this.klineData.set(key, formattedKlines);
        return formattedKlines;
    }

    async getBaseData(symbol) {
        const { priceCache } = this.getBotState();
        const price = priceCache.get(symbol)?.price || 0;
        try {
            const response = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
            const data = await response.json();
            return { price, volume: parseFloat(data.quoteVolume) };
        } catch(e) {
            return { price, volume: 0 };
        }
    }
    
    getObvSlope(klines) {
        if (klines.length < 2) return 0;
        const obv = OBV.calculate({ close: klines.map(k => k.close), volume: klines.map(k => k.volume) });
        return obv.length < 2 ? 0 : obv[obv.length - 1] - obv[obv.length - 2];
    }
    
    getCvdSlope(klines) {
        if (klines.length < 10) return 0;
        return calculateCVD(klines.slice(-5)) - calculateCVD(klines.slice(-10, -5));
    }
}
