import { useState, useEffect, useCallback } from 'react';
import { useSocket, useChat, usePresence } from '../hooks/useSocket';
import * as api from '../api';
import ChatView from '../components/chat/ChatView';
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
  const { toasts, addToast, removeToast } = useToast();

  useEffect(() => {
    api.getWorkspaceInfo().then(setWorkspace).catch(() => {});
    api.getMessages().then(chat.setMessages).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSettingsSaved = useCallback(() => {
    api.getWorkspaceInfo().then(setWorkspace).catch(() => {});
    addToast('Settings saved', 'success');
  }, [addToast]);

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <span className="sidebar-brand"><span className="sidebar-brand-text">Roundtable</span></span>
        </div>
        <div className="sidebar-rooms" />
        <div className="sidebar-footer">
          <div className="user-avatar">{user.display_name.charAt(0).toUpperCase()}</div>
          <div className="user-info"><div className="user-name">{user.display_name}</div></div>
          <button className="btn btn-ghost btn-sm" id="btn-settings" onClick={() => setSettingsOpen(true)} title="Settings">⚙️</button>
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
            onSendMessage={chat.sendMessage}
            onStopGeneration={chat.stopGeneration}
            onTyping={presence.sendTypingStart}
            typingUsers={presence.users.filter(u => u.activity === 'composing')}
          />
        </div>
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
