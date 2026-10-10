// Firebase setup: anonymous auth by default, Google linkable later.
// Career data lives in Firestore; localStorage/IndexedDB is the offline backup.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged,
  GoogleAuthProvider, signInWithRedirect, getRedirectResult, linkWithRedirect,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyC-wRlsMWL8GS4xOAOOaXrQcQ_RbyeUn1s",
  authDomain: "spacewar-45635.firebaseapp.com",
  projectId: "spacewar-45635",
  storageBucket: "spacewar-45635.firebasestorage.app",
  messagingSenderId: "821628266172",
  appId: "1:821628266172:web:d20d628965203aa8f6d2b9"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// Firestore with built-in offline persistence (IndexedDB) — survives where
// localStorage gets wiped, and syncs automatically when back online.
export const db = getFirestore(app);

let currentUser = null;
const authListeners = [];

export function onUser(cb) {
  authListeners.push(cb);
  if (currentUser) cb(currentUser);
}

function notify(user) {
  currentUser = user;
  authListeners.forEach((cb) => cb(user));
}

// Sign in anonymously on boot. No UI, no friction.
export async function ensureAuth(statusEl) {
  try {
    // Handle a Google redirect sign-in completing.
    await getRedirectResult(auth).catch(() => {});
    if (!auth.currentUser) {
      await signInAnonymously(auth);
    }
  } catch (e) {
    console.warn('auth failed, offline mode', e);
  }
  onAuthStateChanged(auth, (user) => {
    notify(user);
    if (statusEl) {
      statusEl.textContent = user
        ? (user.isAnonymous ? `Pilot ${user.uid.slice(0, 6)} (guest)` : (user.displayName || user.email || 'Signed in'))
        : 'Offline';
    }
  });
}

// Upgrade an anonymous account by linking Google. Keeps all existing data.
export async function linkGoogle() {
  if (!auth.currentUser || !auth.currentUser.isAnonymous) return;
  const provider = new GoogleAuthProvider();
  await linkWithRedirect(auth.currentUser, provider);
}

// Fresh Google sign-in (used if not anonymous).
export async function signInGoogle() {
  const provider = new GoogleAuthProvider();
  await signInWithRedirect(auth, provider);
}

export function uid() {
  return currentUser ? currentUser.uid : null;
}

// --- Career profile -------------------------------------------------------
// players/{uid}: { name, xp, rank, bonusPoints, upgrades, stats, updatedAt }
export async function loadProfile() {
  const id = uid();
  if (!id) return null;
  const snap = await getDoc(doc(db, 'players', id)).catch(() => null);
  return snap && snap.exists() ? snap.data() : null;
}

export async function saveProfile(profile) {
  const id = uid();
  if (!id) return false;
  const ref = doc(db, 'players', id);
  await setDoc(ref, { ...profile, updatedAt: serverTimestamp() }, { merge: true }).catch(() => {});
  try {
    localStorage.setItem('spacewar.profile', JSON.stringify({ ...profile, uid: id }));
  } catch (e) { /* storage may be unavailable; Firestore is the source of truth */ }
  return true;
}

// Offline backup: last synced profile, keyed by uid.
export function loadProfileBackup() {
  try {
    const raw = localStorage.getItem('spacewar.profile');
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
