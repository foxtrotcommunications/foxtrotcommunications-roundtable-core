import { useState, type FormEvent } from 'react';
import * as api from '../api';
import type { User } from '../types/workspace';

interface Props { onLogin: (user: User) => void; }

export default function LoginPage({ onLogin }: Props) {
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [error, setError] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    try { const user = await api.login(username, password); onLogin(user); }
    catch (err: unknown) { setError(err instanceof Error ? err.message : 'Login failed'); }
  };

  const handleRegister = async (e: FormEvent) => {
    e.preventDefault();
    try { const user = await api.register(username, password, displayName); onLogin(user); }
    catch (err: unknown) { setError(err instanceof Error ? err.message : 'Registration failed'); }
  };

  return (
    <div className="landing">
      <div className="auth-container">
        <div className="auth-card">
          <div className="auth-logo">
            <h1>Roundtable</h1>
            <p>Multiplayer AI workspace</p>
          </div>

          <div className="auth-tabs">
            <button className={`auth-tab${tab === 'login' ? ' active' : ''}`} onClick={() => { setTab('login'); setError(''); }}>Sign In</button>
            <button className={`auth-tab${tab === 'register' ? ' active' : ''}`} onClick={() => { setTab('register'); setError(''); }}>Register</button>
          </div>

          {error && <div className="auth-error visible">{error}</div>}

          {tab === 'login' ? (
            <form onSubmit={handleLogin}>
              <div className="form-group">
                <label htmlFor="login-username">Username</label>
                <input id="login-username" value={username} onChange={e => setUsername(e.target.value)} required />
              </div>
              <div className="form-group">
                <label htmlFor="login-password">Password</label>
                <input id="login-password" type="password" value={password} onChange={e => setPassword(e.target.value)} required />
              </div>
              <button type="submit" className="btn btn-primary">Sign In</button>
            </form>
          ) : (
            <form onSubmit={handleRegister}>
              <div className="form-group">
                <label htmlFor="reg-username">Username</label>
                <input id="reg-username" value={username} onChange={e => setUsername(e.target.value)} required />
              </div>
              <div className="form-group">
                <label htmlFor="reg-display">Display Name</label>
                <input id="reg-display" value={displayName} onChange={e => setDisplayName(e.target.value)} required />
              </div>
              <div className="form-group">
                <label htmlFor="reg-password">Password</label>
                <input id="reg-password" type="password" value={password} onChange={e => setPassword(e.target.value)} required />
              </div>
              <button type="submit" className="btn btn-primary">Create Account</button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
