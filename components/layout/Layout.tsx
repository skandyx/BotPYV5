
import React, { useEffect, useRef } from 'react';
import Sidebar from './Sidebar';
import Header from './Header';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { websocketService } from '../../services/websocketService';
import { useAuth } from '../../contexts/AuthContext';
import { logService } from '../../services/logService';
import { api } from '../../services/mockApi';
import { scannerStore } from '../../services/scannerStore';
import { useAppContext } from '../../contexts/AppContext';
import { useSidebar } from '../../contexts/SidebarContext';
import { useNotifier } from '../../contexts/NotificationContext';
import { priceStore } from '../../services/priceStore';
import { positionService } from '../../services/positionService';

const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { setConnectionStatus } = useWebSocket();
  const { isAuthenticated } = useAuth();
  const { settingsActivityCounter, refreshData, setSettings, setCircuitBreakerStatus, setFearAndGreed } = useAppContext();
  const { isCollapsed, isMobileOpen, setMobileOpen } = useSidebar();
  const { addNotification } = useNotifier();
  const stalePriceAlerts = useRef(new Set<string>());

  useEffect(() => {
    let staleCheckInterval: number;

    if (isAuthenticated) {
        logService.log('INFO', "User is authenticated, initializing data and WebSocket...");
        websocketService.onStatusChange(setConnectionStatus);
        websocketService.onDataRefresh(refreshData);
        websocketService.onCircuitBreakerUpdate((payload) => setCircuitBreakerStatus(payload.status));
        websocketService.onFearAndGreedUpdate(setFearAndGreed);
        websocketService.onTradeAlert(({level, title, message}) => {
            addNotification(level, title, message);
        });
        websocketService.connect();
        
        const initializeAndFetchData = async () => {
            try {
                logService.log('INFO', 'Fetching settings and initializing...');
                const settingsData = await api.fetchSettings();
                setSettings(settingsData);
                scannerStore.updateSettings(settingsData);
                scannerStore.initialize();
            } catch (error) {
                logService.log('ERROR', `Failed to initialize app data: ${error}`);
            }
        };
        initializeAndFetchData();
        
        // Stale price checker
        staleCheckInterval = window.setInterval(() => {
            const now = Date.now();
            const positions = positionService.getPositions();
            for (const pos of positions) {
                const priceInfo = priceStore.getPrice(pos.symbol);
                if (priceInfo && (now - priceInfo.lastUpdated) > 15000) { // 15s threshold
                    if (!stalePriceAlerts.current.has(pos.symbol)) {
                         const message = `Aucune mise à jour de prix pour ${pos.symbol} depuis plus de 15 secondes. Le P&L pourrait être incorrect.`;
                         addNotification('error', 'Données de Prix Obsolètes', message);
                         stalePriceAlerts.current.add(pos.symbol);
                    }
                } else if (priceInfo) {
                    // Price is fresh again, remove from alert set
                    stalePriceAlerts.current.delete(pos.symbol);
                }
            }
        }, 5000);

    } else {
        logService.log('INFO', "User is not authenticated, disconnecting WebSocket.");
        websocketService.disconnect();
    }
    
    return () => {
      clearInterval(staleCheckInterval);
      if (!isAuthenticated) {
          websocketService.disconnect();
      }
      websocketService.onStatusChange(null);
      websocketService.onDataRefresh(null);
      websocketService.onCircuitBreakerUpdate(null);
      websocketService.onFearAndGreedUpdate(null);
      websocketService.onTradeAlert(null);
    };
  }, [isAuthenticated, setConnectionStatus, settingsActivityCounter, refreshData, setSettings, setCircuitBreakerStatus, setFearAndGreed, addNotification]);

  return (
    <div className="flex h-screen bg-[#0c0e12] overflow-hidden">
      <Sidebar />
      
      {isMobileOpen && (
        <div 
          className="fixed inset-0 bg-black/60 z-40 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        ></div>
      )}

      <div className="flex-1 flex flex-col overflow-hidden relative">
        <Header />
        <main className="flex-1 overflow-y-auto bg-[#0c0e12] p-4 sm:p-6 lg:p-8">
            <div className="w-full">
                {children}
            </div>
        </main>
      </div>
    </div>
  );
};

export default Layout;