// public/js/auth.js — Login/Register UI
(function () {
  const tabs = document.querySelectorAll('.auth-tab');
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const authError = document.getElementById('auth-error');

  if (!tabs.length) return; // Not on landing page

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      loginForm.style.display = target === 'login' ? 'block' : 'none';
      registerForm.style.display = target === 'register' ? 'block' : 'none';
      authError.classList.remove('visible');
    });
  });

  function showError(msg) {
    authError.textContent = msg;
    authError.classList.add('visible');
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await API.login(
        document.getElementById('login-username').value,
        document.getElementById('login-password').value
      );
      window.location.href = '/app';
    } catch (err) {
      showError(err.message);
    }
  });

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await API.register(
        document.getElementById('register-username').value,
        document.getElementById('register-password').value,
        document.getElementById('register-display').value
      );
      window.location.href = '/app';
    } catch (err) {
      showError(err.message);
    }
  });

  // Check if already logged in
  API.me().then(() => {
    window.location.href = '/app';
  }).catch(() => {});
})();
