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

  // ─── @mention notifications ───────────────────────────
  useEffect(() => {
    if (!socket) return;
    const onMessage = (msg: { role: string; content: string; username?: string; display_name?: string }) => {
      if (msg.role === 'user' && msg.username !== user.username) {
        const mentionPattern = new RegExp(`@${user.username}\\b`, 'i');
        const displayMentionPattern = user.displayName
          ? new RegExp(`@${user.displayName}\\b`, 'i')
          : null;
        if (mentionPattern.test(msg.content) || displayMentionPattern?.test(msg.content)) {
          const sender = msg.display_name || msg.username || 'Someone';
          addToast(`${sender} mentioned you`, 'info');
          // Browser notification
          if (Notification.permission === 'granted') {
            new Notification('Roundtable', { body: `${sender} mentioned you: ${msg.content.substring(0, 100)}` });
          } else if (Notification.permission !== 'denied') {
            Notification.requestPermission();
          }
        }
      }
    };
    socket.on('message', onMessage);
    return () => { socket.off('message', onMessage); };
  }, [socket, user.username, user.displayName, addToast]);

  const handleSettingsSaved = useCallback(() => {
    api.getWorkspaceInfo().then(setWorkspace).catch(() => {});
    addToast('Settings saved', 'success');
  }, [addToast]);

  const toggleCodePanel = () => {
    const next = !codePanelOpen;
    setCodePanelOpen(next);
    localStorage.setItem('code-panel-open', String(next));
    // Clear inline resize styles when closing so CSS transition works
    if (!next) {
      const panel = document.querySelector('.code-panel') as HTMLElement;
      if (panel) { panel.style.width = ''; panel.style.minWidth = ''; }
    }
  };

  const handleSendMessage = useCallback((content: string) => {
    chat.sendMessage(content, activeRepo || undefined);
  }, [chat, activeRepo]);

  return (
    <div className="app-layout no-sidebar">
      {/* Main area — no sidebar */}
      <div className="main-area">
        <div id="chat-view">
          <div className="chat-header">
            <div className="chat-header-info">
              <h2>{workspace?.name || 'Roundtable'}</h2>
              <p>{workspace?.ai_provider || 'vertexai'} · {workspace?.ai_model || 'gemini-2.5-flash'}</p>
            </div>
            <div className="chat-header-actions">
              <PresenceBar users={presence.users} />
              <button className="btn btn-ghost btn-sm" onClick={() => setSettingsOpen(true)} title="Settings">⚙️</button>
              <button
                className={`btn btn-ghost btn-sm${codePanelOpen ? ' active' : ''}`}
                onClick={toggleCodePanel}
                title="Code Explorer"
                style={codePanelOpen ? { background: 'var(--accent-glow)', color: 'var(--accent-primary)' } : {}}
              >📁</button>
              <button className="btn btn-ghost btn-sm" onClick={onLogout} title="Logout">↪</button>
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
            currentUsername={user.username}
          />
        </div>

        <CodePanel
          isOpen={codePanelOpen}
          onActiveRepoChange={setActiveRepo}
          addToast={addToast}
          onClose={() => {
            setCodePanelOpen(false);
            localStorage.setItem('code-panel-open', 'false');
            // Clear inline styles from resize drag — they override CSS class transition
            const panel = document.querySelector('.code-panel') as HTMLElement;
            if (panel) { panel.style.width = ''; panel.style.minWidth = ''; }
          }}
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
