/* my-job-agent dashboard UI.
   Auth model (2026-09-02 requirement change): login is required for BOTH
   local and public access. No user session -> sign-in form. Session active ->
   dashboard hub. Google login was removed from the product; password only.
*/
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var views = { login: $('view-login'), dashboard: $('view-dashboard') };
  var shell = $('shell');
  var pill = $('modePill');

  function showView(name) {
    Object.keys(views).forEach(function (k) { views[k].classList.add('hidden'); });
    views[name].classList.remove('hidden');
    if (name === 'dashboard') { shell.classList.add('wide'); }
    else { shell.classList.remove('wide'); }
  }

  function flash(msgEl, kind, text) {
    msgEl.textContent = text;
    msgEl.className = 'msg show ' + kind;
  }
  function clearFlash(msgEl) { msgEl.className = 'msg'; }

  function api(path, opts) {
    opts = opts || {};
    return fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        data.status = res.status;
        return data;
      });
    });
  }

  /* ---- change-password form builder (account section of the dashboard) ---- */
  function changePasswordForm(onDone) {
    var wrap = document.createElement('div');
    var f = document.createElement('form');
    f.autocomplete = 'off';
    f.innerHTML =
      '<label for="oldPassword">Old password</label>' +
      '<input type="password" id="oldPassword" autocomplete="current-password" required />' +
      '<label for="newPassword">New password (min 8 characters)</label>' +
      '<input type="password" id="newPassword" autocomplete="new-password" required />' +
      '<label for="confirmNew">Confirm new password</label>' +
      '<input type="password" id="confirmNew" autocomplete="new-password" required />' +
      '<button type="submit">Change password</button>';
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var oldPassword = f.querySelector('#oldPassword').value;
      var newPassword = f.querySelector('#newPassword').value;
      var confirmNew = f.querySelector('#confirmNew').value;
      if (newPassword !== confirmNew) { return onDone('err', 'New passwords do not match.'); }
      var btn = f.querySelector('button');
      btn.disabled = true;
      api('/auth/change-password', { method: 'POST', body: { oldPassword: oldPassword, newPassword: newPassword } })
        .then(function (d) {
          if (d.status === 200) {
            f.reset();
            onDone('ok', 'Password changed. Sign-in now uses the new password.');
          } else if (d.error === 'invalid_old_password') {
            onDone('err', 'Old password is incorrect.');
          } else if (d.error === 'new_password_too_short') {
            onDone('err', 'New password must be at least 8 characters.');
          } else if (d.error === 'new_password_same') {
            onDone('err', 'New password must differ from the old one.');
          } else {
            onDone('err', (d.detail ? d.error + ': ' + d.detail : 'Change failed (status ' + d.status + ').'));
          }
        })
        .catch(function () { onDone('err', 'Network error — could not reach the server.'); })
        .then(function () { btn.disabled = false; });
    });
    wrap.appendChild(f);
    return wrap;
  }

  function wireLogin() {
    $('loginForm').addEventListener('submit', function (e) {
      e.preventDefault();
      clearFlash($('loginMsg'));
      var btn = $('loginBtn');
      btn.disabled = true;
      api('/auth/login', { method: 'POST', body: { password: $('password').value } })
        .then(function (d) {
          if (d.status === 200 && d.user) {
            location.reload(); // -> /auth/me now returns a user -> dashboard view
          } else {
            flash($('loginMsg'), 'err', d.error === 'invalid_password'
              ? 'Wrong password. Check the operator password or use the recovery link below.'
              : 'Sign-in failed (status ' + d.status + ').');
          }
        })
        .catch(function () { flash($('loginMsg'), 'err', 'Network error — could not reach the server.'); })
        .then(function () { btn.disabled = false; });
    });
    $('forgotBtn').addEventListener('click', function () {
      var btn = $('forgotBtn');
      btn.disabled = true;
      clearFlash($('loginMsg'));
      api('/auth/forgot-password', { method: 'POST' })
        .then(function (d) {
          if (d.status === 200) {
            flash($('loginMsg'), 'ok', 'Password sent to ' + d.sentTo + '. Check that inbox.');
          } else if (d.error === 'smtp_not_configured') {
            flash($('loginMsg'), 'err', 'Recovery email is not enabled yet (no SMTP credentials on the server).');
          } else {
            flash($('loginMsg'), 'err', 'Could not send the recovery email (status ' + d.status + ').');
          }
        })
        .catch(function () { flash($('loginMsg'), 'err', 'Network error — could not reach the server.'); })
        .then(function () { btn.disabled = false; });
    });
  }

  function render(user) {
    if (user) {
      pill.textContent = 'Signed in as operator';
      pill.className = 'pill ok';
      $('whoAmI').textContent = user.name + ' · ' + user.email;
      $('accountChangeSlot').appendChild(changePasswordForm(function (kind, text) { flash($('accountMsg'), kind, text); }));
      $('logoutBtn').addEventListener('click', function () {
        api('/auth/logout', { method: 'POST' }).then(function () { location.reload(); });
      });
      showView('dashboard');
    } else {
      pill.textContent = 'Password required';
      pill.className = 'pill warn';
      wireLogin();
      showView('login');
    }
  }

  api('/auth/me').then(function (d) { render(d.user || null); }).catch(function () {
    pill.textContent = 'Server unreachable';
    showView('login');
  });
})();
