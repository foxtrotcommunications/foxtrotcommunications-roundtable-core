import { useState, useEffect } from 'react';
import LoginPage from './pages/LoginPage';
import WorkspacePage from './pages/WorkspacePage';
import { SocketProvider } from './hooks/useSocket';
import * as api from './api';
import type { User } from './types/workspace';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);

  if (loading) return null;

  if (!user) {
    return <LoginPage onLogin={setUser} />;
  }

  return (
    <SocketProvider>
      <WorkspacePage user={user} onLogout={() => { api.logout(); setUser(null); }} />
    </SocketProvider>
  );
}
