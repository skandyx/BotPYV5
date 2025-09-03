import React, { useState, useMemo } from 'react';
import { api } from '../services/mockApi';
import { scannerStore } from '../services/scannerStore';
import { BacktestResult } from '../types';
import Spinner from '../components/common/Spinner';

type SortableKeys = keyof BacktestResult;
type SortDirection = 'asc' | 'desc';

interface SortConfig {
  key: SortableKeys;
  direction: SortDirection;
}

const BacktestingPage: React.FC = () => {
  const [results, setResults] = useState<BacktestResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortConfig, setSortConfig] = useState<SortConfig | null>({ key: 'netProfitPct', direction: 'desc' });

  const handleRunBacktest = async () => {
    setIsLoading(true);
    setError(null);
    setResults([]);

    try {
      const symbols = scannerStore.getScannedPairs().map(p => p.symbol);
      if (symbols.length === 0) {
        throw new Error("Aucune paire à tester. Veuillez d'abord charger la page du scanner.");
      }
      const backtestData = await api.runBacktest(symbols);
      setResults(backtestData);
    } catch (err: any) {
      setError(err.message || "Une erreur est survenue lors du backtesting.");
    } finally {
      setIsLoading(false);
    }
  };

  const requestSort = (key: SortableKeys) => {
    let direction: SortDirection = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };
  
  const sortedResults = useMemo(() => {
    if (!sortConfig) return results;
    
    return [...results].sort((a, b) => {
        const aValue = a[sortConfig.key];
        const bValue = b[sortConfig.key];
        
        if (aValue === undefined || aValue === null) return 1;
        if (bValue === undefined || bValue === null) return -1;
        
        if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
        if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
    });
  }, [results, sortConfig]);

  const getPnlClass = (pnl: number = 0) => {
    if (pnl > 0) return 'text-green-400';
    if (pnl < 0) return 'text-red-400';
    return 'text-gray-300';
  };

  const SortableHeader: React.FC<{ sortKey: SortableKeys, children: React.ReactNode }> = ({ sortKey, children }) => {
    const isSorted = sortConfig?.key === sortKey;
    const directionIcon = isSorted ? (sortConfig?.direction === 'asc' ? '▲' : '▼') : '';
    return (
        <th 
            scope="col" 
            className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider cursor-pointer"
            onClick={() => requestSort(sortKey)}
        >
            <div className="flex items-center">
                <span>{children}</span>
                <span className="ml-2 text-[#f0b90b]">{directionIcon}</span>
            </div>
        </th>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white">Backtesting de Stratégie</h2>
          <p className="text-sm text-gray-400 mt-1">
            Testez la stratégie "BB Breakdown → Exit @ Upper BB" sur les paires du scanner et plusieurs unités de temps.
          </p>
        </div>
        <button
          onClick={handleRunBacktest}
          disabled={isLoading}
          className="inline-flex items-center justify-center rounded-md border border-transparent bg-[#f0b90b] px-6 py-2 text-sm font-semibold text-black shadow-sm hover:bg-yellow-500 focus:outline-none focus:ring-2 focus:ring-[#f0b90b] focus:ring-offset-2 focus:ring-offset-[#0c0e12] disabled:opacity-50 w-full md:w-auto"
        >
          {isLoading ? <Spinner size="sm" /> : 'Lancer le Backtest sur les Paires du Scanner'}
        </button>
      </div>

      {error && <div className="bg-red-900/50 border border-red-700 text-red-200 px-4 py-3 rounded-lg">{error}</div>}

      <div className="bg-[#14181f]/50 border border-[#2b2f38] rounded-lg shadow-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-[#2b2f38]">
            <thead className="bg-[#14181f]">
              <tr>
                <SortableHeader sortKey="symbol">Symbole</SortableHeader>
                <SortableHeader sortKey="timeframe">Timeframe</SortableHeader>
                <SortableHeader sortKey="netProfitPct">Profit Net (%)</SortableHeader>
                <SortableHeader sortKey="totalTrades">Trades</SortableHeader>
                <SortableHeader sortKey="winRate">Taux de Victoire (%)</SortableHeader>
                <SortableHeader sortKey="profitFactor">Facteur de Profit</SortableHeader>
                <SortableHeader sortKey="maxDrawdownPct">Drawdown Max (%)</SortableHeader>
              </tr>
            </thead>
            <tbody className="bg-[#14181f]/50 divide-y divide-[#2b2f38]">
              {isLoading && (
                <tr>
                  <td colSpan={7} className="text-center py-16">
                    <div className="flex flex-col items-center justify-center gap-4">
                      <Spinner />
                      <span className="text-gray-400">Backtesting en cours...</span>
                    </div>
                  </td>
                </tr>
              )}
              {!isLoading && results.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center py-16 text-gray-500">
                    Cliquez sur "Lancer le Backtest" pour commencer.
                  </td>
                </tr>
              )}
              {sortedResults.map((res, index) => (
                <tr key={`${res.symbol}-${res.timeframe}-${index}`} className="hover:bg-[#2b2f38]/50 transition-colors">
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-white">{res.symbol}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-300">{res.timeframe}</td>
                  <td className={`px-6 py-4 whitespace-nowrap text-sm font-semibold ${getPnlClass(res.netProfitPct)}`}>
                    {res.netProfitPct.toFixed(2)}%
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-300">{res.totalTrades}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-300">{res.winRate.toFixed(1)}%</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-300">{res.profitFactor.toFixed(2)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-red-400">{res.maxDrawdownPct.toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default BacktestingPage;
