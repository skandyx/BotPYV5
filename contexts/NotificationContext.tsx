
import React, { createContext, useState, useContext, ReactNode, useCallback, useEffect } from 'react';

type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

export interface Notification {
  id: number;
  level: NotificationLevel;
  title: string;
  message: string;
}

interface NotificationContextType {
  addNotification: (level: NotificationLevel, title: string, message: string) => void;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

// --- SVG Icons ---
const InfoIcon = () => <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>;
const SuccessIcon = () => <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>;
const WarningIcon = () => <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>;
const ErrorIcon = () => <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>;

const levelStyles: Record<NotificationLevel, { bg: string; text: string; icon: JSX.Element }> = {
    info: { bg: 'bg-sky-900/90 border-sky-700', text: 'text-sky-200', icon: <InfoIcon /> },
    success: { bg: 'bg-green-900/90 border-green-700', text: 'text-green-200', icon: <SuccessIcon /> },
    warning: { bg: 'bg-yellow-900/90 border-yellow-700', text: 'text-yellow-200', icon: <WarningIcon /> },
    error: { bg: 'bg-red-900/90 border-red-700', text: 'text-red-200', icon: <ErrorIcon /> },
};

const NotificationComponent: React.FC<{ notification: Notification; onClose: () => void }> = ({ notification, onClose }) => {
    useEffect(() => {
        if (notification.level === 'warning' || notification.level === 'error') {
            try {
                const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
                if (audioContext.state === 'suspended') {
                    audioContext.resume();
                }
                const oscillator = audioContext.createOscillator();
                const gainNode = audioContext.createGain();
                oscillator.connect(gainNode);
                gainNode.connect(audioContext.destination);
                oscillator.type = 'sine';
                oscillator.frequency.setValueAtTime(notification.level === 'warning' ? 440 : 220, audioContext.currentTime);
                gainNode.gain.setValueAtTime(0.5, audioContext.currentTime);
                gainNode.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.5);
                oscillator.start(audioContext.currentTime);
                oscillator.stop(audioContext.currentTime + 0.5);
            } catch (e) {
                console.error("Could not play notification sound:", e);
            }
        }
    }, [notification.level]);

    const styles = levelStyles[notification.level];

    return (
        <div className={`pointer-events-auto w-full max-w-sm overflow-hidden rounded-lg shadow-lg ring-1 ring-black ring-opacity-5 border backdrop-blur-md ${styles.bg}`}>
            <div className="p-4">
                <div className="flex items-start">
                    <div className={`flex-shrink-0 ${styles.text}`}>
                        {styles.icon}
                    </div>
                    <div className="ml-3 w-0 flex-1 pt-0.5">
                        <p className={`text-sm font-medium ${styles.text}`}>{notification.title}</p>
                        <p className="mt-1 text-sm text-gray-300">{notification.message}</p>
                    </div>
                    <div className="ml-4 flex flex-shrink-0">
                        <button type="button" onClick={onClose} className="inline-flex rounded-md text-gray-400 hover:text-white focus:outline-none focus:ring-2 focus:ring-gray-500">
                            <span className="sr-only">Close</span>
                            <svg className="h-5 w-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" /></svg>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export const NotificationProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const addNotification = useCallback((level: NotificationLevel, title: string, message: string) => {
    const newNotification: Notification = { id: Date.now(), level, title, message };
    setNotifications(prev => [...prev, newNotification]);

    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== newNotification.id));
    }, 15000); // 15 seconds for important messages
  }, []);

  const removeNotification = (id: number) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  };

  return (
    <NotificationContext.Provider value={{ addNotification }}>
      {children}
      <div className="fixed top-20 right-4 w-full max-w-sm z-[100] space-y-3">
        {notifications.map(notification => (
          <NotificationComponent key={notification.id} notification={notification} onClose={() => removeNotification(notification.id)} />
        ))}
      </div>
    </NotificationContext.Provider>
  );
};

export const useNotifier = (): NotificationContextType => {
  const context = useContext(NotificationContext);
  if (context === undefined) {
    throw new Error('useNotifier must be used within a NotificationProvider');
  }
  return context;
};
