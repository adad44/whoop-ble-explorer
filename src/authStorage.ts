export const REMEMBER_ME_STORAGE_KEY = 'whoop-auth-remember-me';

type BrowserStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storageAvailable(storage: Storage | undefined): storage is Storage {
  return typeof storage !== 'undefined';
}

function shouldRememberSession(): boolean {
  if (typeof window === 'undefined' || !storageAvailable(window.localStorage)) {
    return true;
  }
  return window.localStorage.getItem(REMEMBER_ME_STORAGE_KEY) !== 'false';
}

function getStoragePair(): { local?: BrowserStorage; session?: BrowserStorage } {
  if (typeof window === 'undefined') {
    return {};
  }
  return {
    local: storageAvailable(window.localStorage) ? window.localStorage : undefined,
    session: storageAvailable(window.sessionStorage) ? window.sessionStorage : undefined,
  };
}

export function getRememberMePreference(): boolean {
  return shouldRememberSession();
}

export function setRememberMePreference(remember: boolean): void {
  if (typeof window === 'undefined' || !storageAvailable(window.localStorage)) {
    return;
  }
  window.localStorage.setItem(REMEMBER_ME_STORAGE_KEY, remember ? 'true' : 'false');
}

export const authTokenStorage = {
  getItem(key: string): string | null {
    const { local, session } = getStoragePair();
    return local?.getItem(key) ?? session?.getItem(key) ?? null;
  },
  setItem(key: string, value: string): void {
    const { local, session } = getStoragePair();
    if (shouldRememberSession()) {
      local?.setItem(key, value);
      session?.removeItem(key);
      return;
    }
    session?.setItem(key, value);
    local?.removeItem(key);
  },
  removeItem(key: string): void {
    const { local, session } = getStoragePair();
    local?.removeItem(key);
    session?.removeItem(key);
  },
};
