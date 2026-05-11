// public/js/presence.js — Presence UI (replaces rooms.js)
const Presence = {
  updatePresence(users) {
    const bar = document.getElementById('presence-bar');
    if (!bar) return;

    // Colored presence avatars with activity status — use same color as chat messages
    bar.innerHTML = users.map((u) => {
      const name = u.displayName || u.username;
      const colorKey = u.username || name;
      const color = typeof Chat !== 'undefined' && Chat.getUserColor ? Chat.getUserColor(colorKey) : '#6366f1';
      return `
        <div class="presence-avatar" title="${this.escapeHtml(name)}" style="background:${color};">
          ${name.charAt(0).toUpperCase()}
          <div class="presence-dot"></div>
        </div>
      `;
    }).join('');

    // Update typing bar
    const typingBar = document.getElementById('typing-indicator');
    if (typingBar) {
      const typingUsers = users.filter(u => u.activity === 'composing');
      if (typingUsers.length > 0) {
        const names = typingUsers.map(u => u.displayName || u.username).join(', ');
        typingBar.textContent = `${names} ${typingUsers.length === 1 ? 'is' : 'are'} typing...`;
        typingBar.style.opacity = '1';
      } else {
        typingBar.style.opacity = '0';
      }
    }
  },

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },
};
