
import { RSI, ADX, ATR, BollingerBands, EMA, OBV } from 'technicalindicators';

// Simple implementation for CVD
function calculateCVD(klines) {
    let cvd = 0;
    klines.forEach(k => {
        const priceChange = k.close - k.open;
        if (priceChange > 0) cvd += k.volume;
        else if (priceChange < 0) cvd -= k.volume;
    });
    return cvd;
}

export class RealtimeAnalyzerService {
    constructor(log) {
        this.log = log;
        this.settings = {};
        this.klineData = new Map(); // Stores klines for each symbol and timeframe
    }

    updateSettings(settings) {
        this.settings = settings;
    }
    
    async hydrateSymbol(symbol, baseData) {
        // Hydrate with 15m data for initial display
        try {
            const klines15m = await this.fetchKlines(symbol, '15m');
            if (klines15m.length < 50) return null;

            const analysis15m = this.analyzeTimeframe(klines15m, '15m');
            
            return {
                ...baseData,
                ...analysis15m,
            };
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
            // Fetch all required data
            const [baseData, klines1m, klines5m, klines15m, klines1h, klines4h] = await Promise.all([
                this.getBaseData(symbol),
                this.fetchKlines(symbol, '1m'),
                this.fetchKlines(symbol, '5m'),
                this.fetchKlines(symbol, '15m'),
                this.fetchKlines(symbol, '1h'),
                this.fetchKlines(symbol, '4h'),
            ]);

            if (klines15m.length < 50 || klines1h.length < 21 || klines4h.length < 51) {
                return null;
            }

            // Perform analysis on each timeframe
            const analysis1m = this.analyzeTimeframe(klines1m, '1m');
            const analysis5m = this.analyzeTimeframe(klines5m, '5m');
            const analysis15m = this.analyzeTimeframe(klines15m, '15m');
            const analysis1h = this.analyzeTimeframe(klines1h, '1h');
            const analysis4h = this.analyzeTimeframe(klines4h, '4h');
            
            // Combine results and evaluate strategy
            const combined = {
                symbol,
                price: baseData.price,
                volume: baseData.volume,
                priceDirection: 'neutral',
                ...analysis15m,
                ...analysis1h,
                ...analysis4h,
            };

            return this.evaluateStrategy(combined, analysis1m, analysis5m);

        } catch (e) {
            this.log('ERROR', `Full analysis for ${symbol} failed: ${e.message}`);
            return null;
        }
    }

    analyzeTimeframe(klines, interval) {
        if (klines.length === 0) return {};
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
                break;
            case '15m':
                const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
                const lastBB = bb.pop() || { upper: 0, middle: 0, lower: 0 };
                const bbWidths = bb.map(b => ((b.upper - b.lower) / b.middle) * 100);
                const lastWidth = ((lastBB.upper - lastBB.lower) / lastBB.middle) * 100;
                
                bbWidths.sort((a, b) => a - b);
                const squeezeThreshold = bbWidths[Math.floor(bbWidths.length * 0.25)];

                result.bollinger_bands_15m = { ...lastBB, width_pct: lastWidth };
                result.is_in_squeeze_15m = lastWidth < squeezeThreshold;
                result.rsi_15m = RSI.calculate({ period: 14, values: closes }).pop();
                const adxResult = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 }).pop();
                result.adx_15m = adxResult?.adx;
                const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }).pop();
                result.atr_15m = atr;
                result.atr_pct_15m = (atr / closes[closes.length - 1]) * 100;
                break;
            case '1h':
                result.rsi_1h = RSI.calculate({ period: 14, values: closes }).pop();
                break;
            case '4h':
                const lastEma50_4h = EMA.calculate({ period: 50, values: closes }).pop();
                result.price_above_ema50_4h = closes[closes.length - 1] > lastEma50_4h;
                break;
        }
        return result;
    }
    
    evaluateStrategy(pair, analysis1m, analysis5m) {
        let conditions = { trend: false, squeeze: false, breakout: false, volume: false, safety: false, obv: false, rsi_mtf: false, cvd_5m_trending_up: false };
        let score = 'HOLD';
        let score_value = 50;
        let metCount = 0;
        let strategy_type = 'PRECISION';

        // Shared Safety Conditions
        conditions.safety = this.settings.USE_RSI_SAFETY_FILTER ? pair.rsi_1h < this.settings.RSI_OVERBOUGHT_THRESHOLD : true;
        conditions.rsi_mtf = this.settings.USE_RSI_MTF_FILTER ? pair.rsi_15m < this.settings.RSI_15M_OVERBOUGHT_THRESHOLD : true;
        
        // Precision Strategy (Squeeze)
        conditions.trend = pair.price_above_ema50_4h;
        conditions.squeeze = pair.is_in_squeeze_15m;
        
        if(conditions.trend && conditions.squeeze) {
            pair.is_on_hotlist = true;
            score = 'COMPRESSION';
            score_value = 70;
            
            // Micro-trigger checks
            const lastCandle1m = this.klineData.get(`${pair.symbol}_1m`)?.slice(-1)[0];
            if(lastCandle1m) {
                conditions.breakout = lastCandle1m.close > analysis1m.ema9_1m;
                conditions.volume = this.settings.USE_VOLUME_CONFIRMATION ? lastCandle1m.volume > (analysis1m.volume_avg_1m * 1.5) : true;
                conditions.obv = this.settings.USE_OBV_VALIDATION ? analysis1m.obv_1m_slope > 0 : true;
                conditions.cvd_5m_trending_up = this.settings.USE_CVD_FILTER ? analysis5m.cvd_5m_trending_up : true;

                if (conditions.breakout && conditions.volume && conditions.obv && conditions.cvd_5m_trending_up && conditions.safety && conditions.rsi_mtf) {
                    score = this.settings.REQUIRE_STRONG_BUY ? 'BUY' : 'STRONG BUY';
                    score_value = this.settings.REQUIRE_STRONG_BUY ? 85 : 95;
                }
            }
        } else {
             pair.is_on_hotlist = false;
        }
        
        // Ignition Strategy
        if(this.settings.USE_IGNITION_STRATEGY) {
            const lastCandle1m = this.klineData.get(`${pair.symbol}_1m`)?.slice(-1)[0];
            const prevCandle1m = this.klineData.get(`${pair.symbol}_1m`)?.slice(-2)[0];
            if(lastCandle1m && prevCandle1m) {
                const priceSpike = ((lastCandle1m.close - prevCandle1m.close) / prevCandle1m.close) * 100;
                const volumeSpike = lastCandle1m.volume > (analysis1m.volume_avg_1m * this.settings.IGNITION_VOLUME_MULTIPLE);

                if(priceSpike >= this.settings.IGNITION_PRICE_SPIKE_PCT && volumeSpike) {
                    score = 'IGNITION_DETECTED';
                    score_value = 100;
                    strategy_type = 'IGNITION';
                }
            }
        }
        
        Object.values(conditions).forEach(c => { if(c) metCount++ });
        pair.conditions = conditions;
        pair.conditions_met_count = metCount;
        pair.score = score;
        pair.score_value = score_value;
        pair.strategy_type = strategy_type;

        return pair;
    }

    async fetchKlines(symbol, interval, limit = 201) {
        const key = `${symbol}_${interval}`;
        if (this.klineData.has(key)) return this.klineData.get(key);
        
        const klines = await scanner.fetchKlinesFromBinance(symbol, interval, 0, limit);
        const formattedKlines = klines.map(k => ({
            open: parseFloat(k[1]), high: parseFloat(k[2]),
            low: parseFloat(k[3]), close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
        }));
        this.klineData.set(key, formattedKlines);
        return formattedKlines;
    }

    async getBaseData(symbol) {
        const price = botState.priceCache.get(symbol)?.price || 0;
        const response = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
        const data = await response.json();
        return { price, volume: parseFloat(data.quoteVolume) };
    }
    
    getObvSlope(klines) {
        if (klines.length < 2) return 0;
        const obv = OBV.calculate({ close: klines.map(k=>k.close), volume: klines.map(k=>k.volume) });
        if (obv.length < 2) return 0;
        return obv[obv.length-1] - obv[obv.length-2];
    }
    
    getCvdSlope(klines) {
        if (klines.length < 2) return 0;
        const recentKlines = klines.slice(-5);
        const prevKlines = klines.slice(-10, -5);
        return calculateCVD(recentKlines) - calculateCVD(prevKlines);
    }

}
