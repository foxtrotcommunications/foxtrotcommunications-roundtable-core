import { useState, useEffect, useCallback } from 'react';
import { useSocket, useChat, usePresence } from '../hooks/useSocket';
import * as api from '../api';
import ChatView from '../components/chat/ChatView';
import CodePanel from '../components/code-panel/CodePanel';
import PresenceBar from '../components/presence/PresenceBar';
import SettingsModal from '../components/settings/SettingsModal';
import Toast, { useToast } from '../components/common/Toast';
import type { User, Workspace } from '../types/workspace';

interface Props { user: User; onLogout: () => void; }

export default function WorkspacePage({ user, onLogout }: Props) {
  const { socket } = useSocket();
  const chat = useChat(socket);
  const presence = usePresence(socket);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [codePanelOpen, setCodePanelOpen] = useState(
    () => localStorage.getItem('code-panel-open') === 'true'
  );
  const [activeRepo, setActiveRepo] = useState<string | null>(null);
  const { toasts, addToast, removeToast } = useToast();

  useEffect(() => {
    api.getWorkspaceInfo().then(setWorkspace).catch(() => {});
    api.getMessages().then(chat.setMessages).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Forward workspace-changed socket events to the CodePanel via a custom window event
  useEffect(() => {
    if (!socket) return;
    const handler = () => window.dispatchEvent(new Event('workspace-changed'));
    socket.on('workspace-changed', handler);
    return () => { socket.off('workspace-changed', handler); };
  }, [socket]);

  const handleSettingsSaved = useCallback(() => {
    api.getWorkspaceInfo().then(setWorkspace).catch(() => {});
    addToast('Settings saved', 'success');
  }, [addToast]);

  const toggleCodePanel = () => {
    const next = !codePanelOpen;
    setCodePanelOpen(next);
    localStorage.setItem('code-panel-open', String(next));
  };

  const handleSendMessage = useCallback((content: string) => {
    chat.sendMessage(content, activeRepo || undefined);
  }, [chat, activeRepo]);

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <span className="sidebar-brand"><span className="sidebar-brand-text">Roundtable</span></span>
        </div>
        <div className="sidebar-rooms" />
        <div className="sidebar-footer">
          <div className="user-avatar">{(user.displayName || user.username).charAt(0).toUpperCase()}</div>
          <div className="user-info"><div className="user-name">{user.displayName || user.username}</div></div>
          <button className="btn btn-ghost btn-sm" id="btn-settings" onClick={() => setSettingsOpen(true)} title="Settings">⚙️</button>
          <button
            className={`btn btn-ghost btn-sm${codePanelOpen ? ' active' : ''}`}
            id="btn-code-panel"
            onClick={toggleCodePanel}
            title="Code Explorer"
            style={codePanelOpen ? { background: 'var(--accent-glow)', color: 'var(--accent-primary)' } : {}}
          >📁</button>
          <button className="btn btn-ghost btn-sm" onClick={onLogout} title="Logout">↪</button>
        </div>
      </div>

      {/* Main area */}
      <div className="main-area">
        <div id="chat-view">
          <div className="chat-header">
            <div className="chat-header-info">
              <h2>{workspace?.name || 'Roundtable'}</h2>
              <p>{workspace?.ai_provider || 'vertexai'} · {workspace?.ai_model || 'gemini-2.5-flash'}</p>
            </div>
            <div className="chat-header-actions">
              <PresenceBar users={presence.users} />
            </div>
          </div>

          <ChatView
            messages={chat.messages}
            streaming={chat.streaming}
            streamingContent={chat.streamingContent}
            toolCalls={chat.toolCalls}
            onSendMessage={handleSendMessage}
            onStopGeneration={chat.stopGeneration}
            onTyping={presence.sendTypingStart}
            typingUsers={presence.users.filter(u => u.activity === 'composing')}
          />
        </div>

        <CodePanel
          isOpen={codePanelOpen}
          onActiveRepoChange={setActiveRepo}
        />
      </div>

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          onSaved={handleSettingsSaved}
          addToast={addToast}
        />
      )}

      <Toast toasts={toasts} onRemove={removeToast} />
    </div>
  );
}
