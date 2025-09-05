
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

    processAnalyzedPair(pair) {
        if (!this.botState.isRunning) return;

        switch (pair.score) {
            case 'MOMENTUM_BUY':
            case 'IGNITION_DETECTED':
                // Ces signaux sont valides immédiatement.
                this.evaluateSignal(pair);
                break;
            case 'PENDING_CONFIRMATION':
                // Ce signal nécessite une confirmation sur 5m.
                if (this.botState.settings.USE_MTF_VALIDATION) {
                    this.log('TRADE', `Signal de Précision pour ${pair.symbol} mis en attente de confirmation 5m.`);
                    this.botState.pendingConfirmation.set(pair.symbol, { pair, timestamp: Date.now() });
                } else {
                    // Si la validation MTF est désactivée, on traite le signal comme un STRONG BUY.
                    this.evaluateSignal({ ...pair, score: 'STRONG BUY' });
                }
                break;
            default:
                // Ignorer les autres scores (HOLD, COMPRESSION, etc.)
                break;
        }
    }

    checkConfirmationsOn5mClose(symbol, kline5m) {
        if (!this.botState.pendingConfirmation.has(symbol)) return;

        const { pair } = this.botState.pendingConfirmation.get(symbol);
        this.botState.pendingConfirmation.delete(symbol); // Nettoyer, qu'il soit validé ou non.

        const isBullishConfirmation = parseFloat(kline5m.c) > parseFloat(kline5m.o);

        if (isBullishConfirmation) {
            this.log('TRADE', `Confirmation 5m RÉUSSIE pour ${symbol}. Évaluation finale pour entrée.`);
            this.evaluateSignal({ ...pair, score: 'STRONG BUY' });
        } else {
            this.log('TRADE', `Confirmation 5m ÉCHOUÉE pour ${symbol}. Signal invalidé.`);
        }
    }

    evaluateSignal(pair) {
        const { settings, activePositions, recentlyLostSymbols } = this.botState;
        const { symbol, score, atr_15m, price } = pair;

        if (score !== 'STRONG BUY' && score !== 'IGNITION_DETECTED' && score !== 'MOMENTUM_BUY') return;
        if (activePositions.length >= settings.MAX_OPEN_POSITIONS) return;
        if (activePositions.some(p => p.symbol === symbol)) return;
        if (recentlyLostSymbols.has(symbol) && Date.now() < recentlyLostSymbols.get(symbol)) return;

        this.log('TRADE', `Signal confirmé [${score}] pour ${symbol}. Évaluation des conditions d'entrée.`);
        
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
            this.log('WARN', `Calcul de risque invalide pour ${symbol}. Trade annulé.`);
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
            target_quantity: quantity,
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
                this.log('TRADE', `Tentative d'ouverture de position RÉELLE pour ${symbol}...`);
                const orderParams = {
                    symbol,
                    side: 'BUY',
                    type: 'MARKET',
                    quantity: this.formatQuantity(symbol, quantity)
                };
                const orderResult = await this.apiClient.createOrder(orderParams);
                this.log('TRADE', `Ordre Binance réussi : ${JSON.stringify(orderResult)}`);
                newTrade.entry_price = parseFloat(orderResult.fills[0].price);
                newTrade.quantity = parseFloat(orderResult.executedQty);
            } catch(e) {
                this.log('ERROR', `Échec de l'ouverture de la position RÉELLE pour ${symbol}: ${e.message}`);
                return;
            }
        }

        this.botState.balance -= newTrade.entry_price * newTrade.quantity;
        this.botState.activePositions.push(newTrade);
        this.log('TRADE', `SUCCÈS: Position ${newTrade.mode} ouverte pour ${symbol}. Qté: ${newTrade.quantity}, Entrée: ${newTrade.entry_price}, Strat: ${strategy_type}`);
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
        
        if (position.strategy_type === 'IGNITION' && this.botState.settings.USE_IGNITION_TRAILING_STOP) {
            const trailingStopPct = this.botState.settings.IGNITION_TRAILING_STOP_PCT / 100;
            const newStopLoss = position.highest_price_since_entry * (1 - trailingStopPct);
            if (newStopLoss > position.stop_loss) position.stop_loss = newStopLoss;
            if (currentPrice <= position.stop_loss) {
                exitReason = 'Stop Suiveur Ignition atteint';
                exitPrice = position.stop_loss;
            }
        } else {
            if (currentPrice <= position.stop_loss) {
                exitReason = 'Stop Loss atteint';
                exitPrice = position.stop_loss;
            } else if (currentPrice >= position.take_profit) {
                exitReason = 'Take Profit atteint';
                exitPrice = position.take_profit;
            }
        }
        
        if (exitReason) {
            this.log('TRADE', `${exitReason} pour ${position.symbol} au prix de ${exitPrice}.`);
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
                this.log('TRADE', `Tentative de clôture de position RÉELLE pour ${closedTrade.symbol}...`);
                await this.apiClient.createOrder({
                    symbol: closedTrade.symbol,
                    side: 'SELL',
                    type: 'MARKET',
                    quantity: this.formatQuantity(closedTrade.symbol, closedTrade.quantity)
                });
                this.log('TRADE', `Ordre de VENTE Binance réussi pour ${closedTrade.symbol}`);
            } catch(e) {
                this.log('ERROR', `Échec de la clôture de la position RÉELLE pour ${closedTrade.symbol}: ${e.message}`);
            }
        }
        
        this.botState.balance += (closedTrade.entry_price * closedTrade.quantity) + pnl;
        this.botState.tradeHistory.push(closedTrade);

        if (pnl < 0) {
            const cooldownUntil = Date.now() + (this.botState.settings.LOSS_COOLDOWN_HOURS * 60 * 60 * 1000);
            this.botState.recentlyLostSymbols.set(closedTrade.symbol, cooldownUntil);
        }
        
        this.log('TRADE', `Position clôturée pour ${closedTrade.symbol}. PnL: $${pnl.toFixed(2)} (${closedTrade.pnl_pct.toFixed(2)}%). Nouveau Solde: $${this.botState.balance.toFixed(2)}`);
        
        await this.saveData('state');
        this.broadcast({ type: 'POSITIONS_UPDATED' });
    }

    async manualClose(tradeId, currentPrice) {
        const position = this.botState.activePositions.find(p => p.id === tradeId);
        if (!position) return { success: false, message: 'Position non trouvée.' };
        if (!currentPrice) currentPrice = position.average_entry_price;
        
        await this.closePosition(position, currentPrice);
        
        return { success: true, trade: position };
    }
    
    formatQuantity(symbol, quantity) {
        const rules = this.symbolRules.get(symbol);
        if (!rules || !rules.stepSize) return parseFloat(quantity.toFixed(8));
        if (rules.stepSize === 1) return Math.floor(quantity);
        const precision = Math.max(0, -Math.log10(rules.stepSize));
        const factor = Math.pow(10, precision);
        return Math.floor(quantity * factor) / factor;
    }
}
