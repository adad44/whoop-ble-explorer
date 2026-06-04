const REMEMBER_ME_STORAGE_KEY = 'whoop-auth-remember-me';

export function getRememberMePreference(): boolean {
  if (typeof window === 'undefined') {
    return true;
  }
  return window.localStorage.getItem(REMEMBER_ME_STORAGE_KEY) !== 'false';
}

export function setRememberMePreference(remember: boolean): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(REMEMBER_ME_STORAGE_KEY, remember ? 'true' : 'false');
}
