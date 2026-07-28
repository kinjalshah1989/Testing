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

function updateProfileMenus(user) {
  document.querySelectorAll('.profile-menu-wrap').forEach(wrap => {
    const trigger = wrap.querySelector('.profile-trigger, .profile-icon-link');
    const dropdown = wrap.querySelector('.profile-dropdown');
    if (!dropdown) return;

    let memberLink = dropdown.querySelector('[data-universal-member-link]');
    let loginLink = dropdown.querySelector('[data-universal-login-link]');
    let logoutButton = dropdown.querySelector('.global-profile-logout');

    if (!memberLink) {
      memberLink = document.createElement('a');
      memberLink.dataset.universalMemberLink = '';
      memberLink.setAttribute('role', 'menuitem');
      memberLink.textContent = 'Member Profile';
      dropdown.prepend(memberLink);
    }
    if (!loginLink) {
      loginLink = document.createElement('a');
      loginLink.dataset.universalLoginLink = '';
      loginLink.setAttribute('role', 'menuitem');
      loginLink.textContent = 'Log in';
      memberLink.insertAdjacentElement('afterend', loginLink);
    }
    if (!logoutButton) {
      logoutButton = document.createElement('button');
      logoutButton.type = 'button';
      logoutButton.className = 'profile-dropdown-logout global-profile-logout';
      logoutButton.setAttribute('role', 'menuitem');
      logoutButton.textContent = 'Log Out';
      dropdown.append(logoutButton);
    }

    memberLink.href = accountBase;
    loginLink.href = `${accountBase}?action=login`;

    // Signed-out customers can access the member/sign-in options. Once Firebase
    // confirms a completed sign-in or sign-up, the combined profile dropdown
    // contains one option only: the universal Log Out button.
    memberLink.hidden = !!user;
    loginLink.hidden = !!user;
    memberLink.style.display = user ? 'none' : '';
    loginLink.style.display = user ? 'none' : '';

    logoutButton.hidden = !user;
    logoutButton.style.display = user ? 'block' : 'none';
    logoutButton.disabled = false;
    logoutButton.textContent = 'Log Out';

    dropdown.dataset.authMenuState = user ? 'signed-in' : 'signed-out';

    if (trigger) {
      trigger.classList.toggle('logged-in', !!user);
      trigger.dataset.profileSignedIn = user ? 'true' : 'false';
      trigger.dataset.orderSummaryUrl = `${accountBase}#order-summary`;
      trigger.title = user ? `Signed in as ${user.email || 'member'}` : 'Sign up or log in';
      trigger.setAttribute('aria-label', user ? 'Open member profile menu' : 'Open member profile sign up and login');
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
