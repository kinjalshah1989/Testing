import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: ["AI", "zaSyBise9pqTYgQwmG-xOVZQ0-30j1EvcgDng"].join(""),
  authDomain: "the-global-rani-website.firebaseapp.com",
  projectId: "the-global-rani-website",
  storageBucket: "the-global-rani-website.firebasestorage.app",
  messagingSenderId: "603989663669",
  appId: "1:603989663669:web:24c32f6c1bce81a20803fc"
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const inCategory = location.pathname.includes('/categories/');
const accountBase = inCategory ? '../account.html' : 'account.html';
const homeBase = inCategory ? '../index.html' : 'index.html';

function preserveCartAndClearMemberData() {
  const savedCart = sessionStorage.getItem('globalRaniCart');
  const keys = [
    'globalRaniLoggedInMember', 'globalRaniCheckoutMode',
    'globalRaniRequireShippingVerification', 'globalRaniReturnToCheckoutAfterVerify',
    'globalRaniCustomerProfile', 'globalRaniGuestShippingProfile',
    'globalRaniGuestShippingDraft', 'globalRaniShippingProfiles',
    'globalRaniScrollToCheckout', 'globalRaniSelectedTryOn'
  ];
  keys.forEach(key => {
    sessionStorage.removeItem(key);
    localStorage.removeItem(key);
  });
  if (savedCart !== null) sessionStorage.setItem('globalRaniCart', savedCart);
}

function signedInFromSession() {
  try {
    const member = JSON.parse(sessionStorage.getItem('globalRaniLoggedInMember') || 'null');
    return !!(member && member.email);
  } catch (_) {
    return false;
  }
}

function updateProfileMenus(user) {
  const signedIn = !!user || signedInFromSession();

  document.querySelectorAll('.profile-menu-wrap').forEach(wrap => {
    const trigger = wrap.querySelector('.profile-trigger, .profile-icon-link');
    const dropdown = wrap.querySelector('.profile-dropdown');
    if (!dropdown) return;

    // Keep exactly one universal Log Out option after a successful login/sign-up.
    // Remove every old account, member-profile, login, sign-up, order-summary,
    // duplicate logout, or dynamically injected menu item.
    if (signedIn) {
      [...dropdown.children].forEach(child => child.remove());

      const logoutButton = document.createElement('button');
      logoutButton.type = 'button';
      logoutButton.className = 'profile-dropdown-logout global-profile-logout';
      logoutButton.setAttribute('role', 'menuitem');
      logoutButton.textContent = 'Log Out';
      dropdown.append(logoutButton);
    } else {
      [...dropdown.children].forEach(child => child.remove());

      const memberLink = document.createElement('a');
      memberLink.dataset.universalMemberLink = '';
      memberLink.setAttribute('role', 'menuitem');
      memberLink.href = accountBase;
      memberLink.textContent = 'Member Profile';

      const loginLink = document.createElement('a');
      loginLink.dataset.universalLoginLink = '';
      loginLink.setAttribute('role', 'menuitem');
      loginLink.href = `${accountBase}?action=login`;
      loginLink.textContent = 'Log In';

      dropdown.append(memberLink, loginLink);
    }

    dropdown.dataset.authMenuState = signedIn ? 'signed-in' : 'signed-out';

    if (trigger) {
      trigger.classList.toggle('logged-in', signedIn);
      trigger.dataset.profileSignedIn = signedIn ? 'true' : 'false';
      trigger.removeAttribute('data-order-summary-url');
      trigger.title = signedIn ? 'Open Log Out menu' : 'Open profile menu';
      trigger.setAttribute('aria-label', signedIn ? 'Open Log Out menu' : 'Open profile sign-up and login menu');
      trigger.setAttribute('aria-haspopup', 'menu');
    }
  });
}

onAuthStateChanged(auth, user => {
  if (user) {
    sessionStorage.setItem('globalRaniLoggedInMember', JSON.stringify({
      firstName: '', lastName: '', email: user.email || '', uid: user.uid || ''
    }));
    sessionStorage.setItem('globalRaniCheckoutMode', 'member');
  } else {
    sessionStorage.removeItem('globalRaniLoggedInMember');
  }
  updateProfileMenus(user);
});

// Apply the correct menu immediately while Firebase restores its session.
updateProfileMenus(null);

// Some legacy page scripts try to add old profile links again. Re-normalize the
// dropdown so signed-in customers continue to see only the universal Log Out.
const profileObserver = new MutationObserver(() => {
  clearTimeout(profileObserver._timer);
  profileObserver._timer = setTimeout(() => updateProfileMenus(auth.currentUser), 0);
});
document.querySelectorAll('.profile-dropdown').forEach(dropdown => {
  profileObserver.observe(dropdown, { childList: true });
});



function closeAllProfileDropdowns(exceptWrap = null) {
  document.querySelectorAll('.profile-menu-wrap.open').forEach(wrap => {
    if (wrap === exceptWrap) return;
    wrap.classList.remove('open');
    const trigger = wrap.querySelector('.profile-trigger, .profile-icon-link');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  });
}

// Universal combined-profile dropdown controller. The downward arrow is part
// of the combined profile button, and pressing it always opens the dropdown.
document.addEventListener('click', event => {
  if (event.target.closest('.global-profile-logout')) return;

  const trigger = event.target.closest('.profile-trigger, .profile-icon-link');
  if (trigger && trigger.closest('.profile-menu-wrap')) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const wrap = trigger.closest('.profile-menu-wrap');
    const willOpen = !wrap.classList.contains('open');
    closeAllProfileDropdowns(wrap);
    wrap.classList.toggle('open', willOpen);
    trigger.setAttribute('aria-expanded', String(willOpen));

    if (willOpen) {
      const firstVisibleItem = [...wrap.querySelectorAll('.profile-dropdown a, .profile-dropdown button')]
        .find(item => !item.hidden && getComputedStyle(item).display !== 'none');
      if (firstVisibleItem) setTimeout(() => firstVisibleItem.focus(), 0);
    }
    return;
  }

  if (!event.target.closest('.profile-menu-wrap')) closeAllProfileDropdowns();
}, true);

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  closeAllProfileDropdowns();
}, true);

// Capture phase makes this the one logout handler everywhere.
document.addEventListener('click', async event => {
  const button = event.target.closest('.global-profile-logout');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  if (button.disabled) return;

  button.disabled = true;
  button.textContent = 'Logging Out…';
  try {
    preserveCartAndClearMemberData();
    await signOut(auth);
    window.dispatchEvent(new Event('globalRaniMemberChanged'));
    window.location.replace(homeBase);
  } catch (error) {
    console.error('Logout failed:', error);
    button.disabled = false;
    button.textContent = 'Log Out';
    alert('Logout failed. Please try again.');
  }
}, true);
