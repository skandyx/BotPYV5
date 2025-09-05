

export class TradingEngineService {
    constructor(botState, log, broadcast, saveData, binanceApiClient, symbolRules) {
        this.botState = botState;
        this.log = log;
        this.broadcast = broadcast;
        this.saveData = saveData;
        this.apiClient = binanceApiClient;
        this.symbolRules = symbolRules;
    }

    updateSettings(settings) {
        this.botState.settings = settings;
    }

    updateApiClient(client) {
        this.apiClient = client;
    }

    evaluateSignal(pair) {
        if (!this.botState.isRunning) return;

        const { settings, activePositions, recentlyLostSymbols } = this.botState;
        const { symbol, score, atr_15m, price } = pair;

        if (score !== 'STRONG BUY' && score !== 'IGNITION_DETECTED') return;
        if (activePositions.length >= settings.MAX_OPEN_POSITIONS) return;
        if (activePositions.some(p => p.symbol === symbol)) return;
        if (recentlyLostSymbols.has(symbol) && Date.now() < recentlyLostSymbols.get(symbol)) return;

        this.log('TRADE', `High quality signal [${score}] detected for ${symbol}. Evaluating for trade entry.`);
        
        let positionSizePct = settings.POSITION_SIZE_PCT;
        if (settings.USE_DYNAMIC_POSITION_SIZING && score === 'STRONG BUY') {
            positionSizePct = settings.STRONG_BUY_POSITION_SIZE_PCT;
        }
        const positionSizeUSD = this.botState.balance * (positionSizePct / 100);
        const quantity = positionSizeUSD / price;

        let stopLossPrice;
        if (settings.USE_ATR_STOP_LOSS && atr_15m) {
            stopLossPrice = price - (atr_15m * settings.ATR_MULTIPLIER);
        } else {
            stopLossPrice = price * (1 - settings.STOP_LOSS_PCT / 100);
        }

        const riskPerUnit = price - stopLossPrice;
        if (riskPerUnit <= 0) {
            this.log('WARN', `Invalid risk calculation for ${symbol}. Aborting trade.`);
            return;
        }

        const takeProfitPrice = price + (riskPerUnit * settings.RISK_REWARD_RATIO);
        
        this.openPosition(pair, quantity, stopLossPrice, takeProfitPrice);
    }
    
    async openPosition(pair, quantity, stopLoss, takeProfit) {
        const { symbol, price, score, strategy_type } = pair;
        const newTrade = {
            id: this.botState.tradeIdCounter++,
            mode: this.botState.tradingMode,
            symbol,
            side: 'BUY',
            entry_price: price,
            average_entry_price: price,
            quantity,
            target_quantity: quantity, // For scaling in later
            stop_loss: stopLoss,
            take_profit: takeProfit,
            entry_time: new Date().toISOString(),
            status: 'FILLED',
            pnl: 0,
            pnl_pct: 0,
            entry_snapshot: pair,
            highest_price_since_entry: price,
            total_cost_usd: price * quantity,
            strategy_type
        };

        if (this.botState.tradingMode === 'REAL_LIVE' && this.apiClient) {
            try {
                this.log('TRADE', `Attempting to open REAL LIVE position for ${symbol}...`);
                const orderParams = {
                    symbol,
                    side: 'BUY',
                    type: 'MARKET',
                    quantity: this.formatQuantity(symbol, quantity)
                };
                const orderResult = await this.apiClient.createOrder(orderParams);
                this.log('TRADE', `Binance order successful: ${JSON.stringify(orderResult)}`);
                // Update trade with actual executed price and quantity
                newTrade.entry_price = parseFloat(orderResult.fills[0].price);
                newTrade.quantity = parseFloat(orderResult.executedQty);

            } catch(e) {
                this.log('ERROR', `Failed to open REAL LIVE position for ${symbol}: ${e.message}`);
                return; // Do not proceed if real order fails
            }
        }

        this.botState.balance -= newTrade.entry_price * newTrade.quantity;
        this.botState.activePositions.push(newTrade);
        this.log('TRADE', `SUCCESS: Opened ${newTrade.mode} position for ${symbol}. Qty: ${newTrade.quantity}, Entry: ${newTrade.entry_price}`);
        await this.saveData('state');
        this.broadcast({ type: 'POSITIONS_UPDATED' });
    }

    checkAllPositions() {
        if (!this.botState.isRunning) return;
        this.botState.activePositions.forEach(pos => this.checkPosition(pos));
    }

    checkPosition(position) {
        const currentPrice = this.botState.priceCache.get(position.symbol)?.price;
        if (!currentPrice) return;
        
        position.highest_price_since_entry = Math.max(position.highest_price_since_entry, currentPrice);

        let exitReason = null;
        let exitPrice = currentPrice;

        if (currentPrice <= position.stop_loss) {
            exitReason = 'Stop Loss hit';
            exitPrice = position.stop_loss;
        } else if (currentPrice >= position.take_profit) {
            exitReason = 'Take Profit hit';
            exitPrice = position.take_profit;
        }
        
        // Add Trailing Stop Loss logic here later

        if (exitReason) {
            this.log('TRADE', `${exitReason} for ${position.symbol} at price ${exitPrice}.`);
            this.closePosition(position, exitPrice);
        }
    }

    async closePosition(position, exitPrice) {
        const positionIndex = this.botState.activePositions.findIndex(p => p.id === position.id);
        if (positionIndex === -1) return;

        const [closedTrade] = this.botState.activePositions.splice(positionIndex, 1);
        
        closedTrade.exit_price = exitPrice;
        closedTrade.exit_time = new Date().toISOString();
        closedTrade.status = 'CLOSED';
        
        const pnl = (exitPrice - closedTrade.entry_price) * closedTrade.quantity;
        closedTrade.pnl = pnl;
        closedTrade.pnl_pct = (pnl / (closedTrade.entry_price * closedTrade.quantity)) * 100;
        
        if (this.botState.tradingMode === 'REAL_LIVE' && this.apiClient) {
             try {
                this.log('TRADE', `Attempting to close REAL LIVE position for ${closedTrade.symbol}...`);
                await this.apiClient.createOrder({
                    symbol: closedTrade.symbol,
                    side: 'SELL',
                    type: 'MARKET',
                    quantity: this.formatQuantity(closedTrade.symbol, closedTrade.quantity)
                });
                this.log('TRADE', `Binance SELL order successful for ${closedTrade.symbol}`);
            } catch(e) {
                this.log('ERROR', `Failed to close REAL LIVE position for ${closedTrade.symbol}: ${e.message}`);
                // In real life, you'd have more robust error handling here
            }
        }
        
        this.botState.balance += (closedTrade.entry_price * closedTrade.quantity) + pnl;
        this.botState.tradeHistory.push(closedTrade);

        if (pnl < 0) {
            const cooldownUntil = Date.now() + (this.botState.settings.LOSS_COOLDOWN_HOURS * 60 * 60 * 1000);
            this.botState.recentlyLostSymbols.set(closedTrade.symbol, cooldownUntil);
        }
        
        this.log('TRADE', `Closed position for ${closedTrade.symbol}. PnL: $${pnl.toFixed(2)} (${closedTrade.pnl_pct.toFixed(2)}%). New Balance: $${this.botState.balance.toFixed(2)}`);
        
        await this.saveData('state');
        this.broadcast({ type: 'POSITIONS_UPDATED' });
    }

    async manualClose(tradeId, currentPrice) {
        const position = this.botState.activePositions.find(p => p.id === tradeId);
        if (!position) return { success: false, message: 'Position not found.' };
        if (!currentPrice) currentPrice = position.average_entry_price; // Failsafe
        
        await this.closePosition(position, currentPrice);
        
        return { success: true, trade: position };
    }
    
    formatQuantity(symbol, quantity) {
        const rules = this.symbolRules.get(symbol);
        if (!rules || !rules.stepSize) return parseFloat(quantity.toFixed(8));
        if (rules.stepSize === 1) return Math.floor(quantity);
        const precision = Math.max(0, Math.log10(1 / rules.stepSize));
        const factor = Math.pow(10, precision);
        return Math.floor(quantity * factor) / factor;
    }
}
