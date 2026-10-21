(function () {
  'use strict';

  const SEEDED_PERSONAS = [
    {
      username: 'alice',
      displayName: 'Alice Rivera',
      role: 'Principal Architect • #architecture-review',
    },
    {
      username: 'bob',
      displayName: 'Bob Chen',
      role: 'Staff SRE • #sre-1m-websockets',
    },
    {
      username: 'charlie',
      displayName: 'Charlie Patel',
      role: 'Security Engineer • CSP & JWT Auditor',
    },
    {
      username: 'diana',
      displayName: 'Diana Okafor',
      role: 'Product Lead • Global Latency SLA',
    },
  ];

  function openLoginModal(titleText, bodyText) {
    const dialog = document.getElementById('login-dialog');
    const titleEl = document.getElementById('login-dialog-title');
    const bodyEl = document.getElementById('login-dialog-body');
    if (titleEl) titleEl.textContent = titleText;
    if (bodyEl) bodyEl.textContent = bodyText;
    if (dialog && typeof dialog.showModal === 'function') {
      dialog.showModal();
    }
  }

  function setupDialogLightDismissFallback() {
    const dialog = document.getElementById('login-dialog');
    if (!dialog) return;
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      dialog.addEventListener('click', function (event) {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const isInDialog =
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width;
        if (!isInDialog) dialog.close();
      });
    }
  }

  async function checkAlreadySignedIn() {
    // Allow explicit account switching when ?switch=1 is in the query string
    if (window.location.search.includes('switch=1')) {
      return;
    }
    try {
      const res = await fetch('/v1/auth/me', { credentials: 'same-origin' });
      if (res.ok) {
        window.location.replace('/chat');
      }
    } catch (_e) {
      // stay on login page
    }
  }

  async function checkBackendHealth() {
    try {
      const res = await fetch('/v1/health', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      const pill = document.getElementById('login-health-pill');
      if (pill) {
        pill.textContent =
          'Spanner & Firestore: ' + (data.status || 'HEALTHY');
        pill.className = 'pill ready';
      }
    } catch (_e) {
      // ignore
    }
  }

  async function fetchPreAuthCsrfToken() {
    const res = await fetch('/v1/auth/csrf', { credentials: 'same-origin' });
    if (!res.ok) {
      throw new Error('Unable to acquire CSRF token');
    }
    const data = await res.json();
    return data.csrf_token || '';
  }

  async function performSignIn(identifier, password) {
    try {
      const csrfToken = await fetchPreAuthCsrfToken();
      const res = await fetch('/v1/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          identifier: identifier,
          password: password,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(function () {
          return {};
        });
        openLoginModal(
          'Sign-In Failed',
          errData.error || 'Invalid username/email or password.'
        );
        return;
      }

      // Redirect to the dedicated Chat Page (/chat)
      window.location.assign('/chat');
    } catch (_err) {
      openLoginModal(
        'Network Error',
        'Unable to reach authentication service. Please try again.'
      );
    }
  }

  async function performSignUp(displayName, username, email, password) {
    try {
      const csrfToken = await fetchPreAuthCsrfToken();
      const res = await fetch('/v1/auth/register', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          display_name: displayName,
          username: username,
          email: email,
          password: password,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(function () {
          return {};
        });
        openLoginModal(
          'Account Creation Failed',
          errData.error || 'Could not register account.'
        );
        return;
      }

      // Redirect to the dedicated Chat Page (/chat)
      window.location.assign('/chat');
    } catch (_err) {
      openLoginModal(
        'Network Error',
        'Unable to reach registration service. Please try again.'
      );
    }
  }

  async function performDemoPersonaSignIn(username) {
    try {
      const csrfToken = await fetchPreAuthCsrfToken();
      const res = await fetch('/v1/auth/demo-login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ username: username }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(function () {
          return {};
        });
        openLoginModal(
          'Demo Sign-In Failed',
          errData.error || 'Could not sign in with demo persona.'
        );
        return;
      }

      window.location.assign('/chat');
    } catch (_err) {
      openLoginModal(
        'Network Error',
        'Unable to reach authentication service. Please try again.'
      );
    }
  }

  function renderPersonaCards() {
    const container = document.getElementById('persona-list');
    if (!container) return;
    container.replaceChildren();

    SEEDED_PERSONAS.forEach(function (p) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'persona-btn';

      const infoDiv = document.createElement('div');
      const nameDiv = document.createElement('div');
      nameDiv.className = 'persona-name';
      nameDiv.textContent = p.displayName + ' (@' + p.username + ')';

      const roleDiv = document.createElement('div');
      roleDiv.className = 'persona-role';
      roleDiv.textContent = p.role;

      infoDiv.appendChild(nameDiv);
      infoDiv.appendChild(roleDiv);

      const actionSpan = document.createElement('span');
      actionSpan.className = 'pill';
      actionSpan.textContent = 'Sign In →';

      btn.appendChild(infoDiv);
      btn.appendChild(actionSpan);

      btn.addEventListener('click', function () {
        performDemoPersonaSignIn(p.username);
      });

      container.appendChild(btn);
    });
  }

  function setupPasswordToggle(btnId, inputId) {
    const btn = document.getElementById(btnId);
    const input = document.getElementById(inputId);
    if (!btn || !input) return;
    btn.addEventListener('click', function () {
      const isPassword = input.getAttribute('type') === 'password';
      input.setAttribute('type', isPassword ? 'text' : 'password');
      btn.textContent = isPassword ? 'Hide' : 'Show';
      btn.setAttribute(
        'aria-label',
        isPassword ? 'Hide password' : 'Show password'
      );
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    setupDialogLightDismissFallback();
    renderPersonaCards();
    checkBackendHealth();
    checkAlreadySignedIn();

    const tabSignIn = document.getElementById('tab-signin');
    const tabSignUp = document.getElementById('tab-signup');
    const formSignIn = document.getElementById('signin-form');
    const formSignUp = document.getElementById('signup-form');

    if (tabSignIn && tabSignUp && formSignIn && formSignUp) {
      tabSignIn.addEventListener('click', function () {
        tabSignIn.classList.add('active');
        tabSignIn.setAttribute('aria-selected', 'true');
        tabSignUp.classList.remove('active');
        tabSignUp.setAttribute('aria-selected', 'false');
        formSignIn.hidden = false;
        formSignUp.hidden = true;
      });

      tabSignUp.addEventListener('click', function () {
        tabSignUp.classList.add('active');
        tabSignUp.setAttribute('aria-selected', 'true');
        tabSignIn.classList.remove('active');
        tabSignIn.setAttribute('aria-selected', 'false');
        formSignUp.hidden = false;
        formSignIn.hidden = true;
      });
    }

    setupPasswordToggle('toggle-signin-pw', 'current-password');
    setupPasswordToggle('toggle-signup-pw', 'new-password');

    if (formSignIn) {
      formSignIn.addEventListener('submit', function (ev) {
        ev.preventDefault();
        const idInput = document.getElementById('signin-identifier');
        const pwInput = document.getElementById('current-password');
        if (!idInput || !pwInput) return;
        const identifier = idInput.value.trim();
        const password = pwInput.value;
        if (!identifier || !password) {
          openLoginModal('Validation Error', 'Please enter both username/email and password.');
          return;
        }
        performSignIn(identifier, password);
      });
    }

    if (formSignUp) {
      formSignUp.addEventListener('submit', function (ev) {
        ev.preventDefault();
        const nameInput = document.getElementById('signup-display-name');
        const userInput = document.getElementById('signup-username');
        const emailInput = document.getElementById('signup-email');
        const pwInput = document.getElementById('new-password');
        if (!nameInput || !userInput || !emailInput || !pwInput) return;

        const displayName = nameInput.value.trim();
        const username = userInput.value.trim();
        const email = emailInput.value.trim();
        const password = pwInput.value;

        if (!displayName || !username || !email || password.length < 8) {
          openLoginModal(
            'Validation Error',
            'Please fill in all fields and use a password of at least 8 characters.'
          );
          return;
        }
        performSignUp(displayName, username, email, password);
      });
    }
  });
})();
