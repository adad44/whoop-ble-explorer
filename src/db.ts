import type { BatteryReading, Bookmark, HeartRateReading, PacketRecord } from './types';

const DB_NAME = 'whoop-ble-explorer';
const DB_VERSION = 1;

type StoreName = 'packet_records' | 'heart_rate_readings' | 'battery_readings' | 'bookmarks';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      createStore(db, 'packet_records', ['sessionId', 'deviceId', 'serviceUuid', 'characteristicUuid', 'direction', 'timestamp']);
      createStore(db, 'heart_rate_readings', ['sessionId', 'deviceId', 'timestamp']);
      createStore(db, 'battery_readings', ['sessionId', 'deviceId', 'timestamp']);
      createStore(db, 'bookmarks', ['deviceId', 'serviceUuid', 'characteristicUuid', 'timestamp']);
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open IndexedDB.'));
  });

  return dbPromise;
}

function createStore(db: IDBDatabase, name: StoreName, indexes: string[]): void {
  if (db.objectStoreNames.contains(name)) {
    return;
  }
  const store = db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
  indexes.forEach((index) => store.createIndex(index, index, { unique: false }));
}

async function tx<T>(storeName: StoreName, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const request = action(store);
    let result: T | undefined;

    if (request) {
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error ?? new Error(`IndexedDB request failed for ${storeName}.`));
    }

    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error ?? new Error(`IndexedDB transaction failed for ${storeName}.`));
  });
}

export async function addPacket(record: PacketRecord): Promise<void> {
  await tx<IDBValidKey>('packet_records', 'readwrite', (store) => store.add(record));
}

export async function addHeartRateReading(reading: HeartRateReading): Promise<void> {
  await tx<IDBValidKey>('heart_rate_readings', 'readwrite', (store) => store.add(reading));
}

export async function addBatteryReading(reading: BatteryReading): Promise<void> {
  await tx<IDBValidKey>('battery_readings', 'readwrite', (store) => store.add(reading));
}

export async function addBookmark(bookmark: Bookmark): Promise<void> {
  await tx<IDBValidKey>('bookmarks', 'readwrite', (store) => store.add(bookmark));
}

export async function getAllPackets(): Promise<PacketRecord[]> {
  return (await tx<PacketRecord[]>('packet_records', 'readonly', (store) => store.getAll())) ?? [];
}

export async function getRecentPackets(limit = 100): Promise<PacketRecord[]> {
  const all = await getAllPackets();
  return all.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
}

export async function getAllHeartRateReadings(): Promise<HeartRateReading[]> {
  return (await tx<HeartRateReading[]>('heart_rate_readings', 'readonly', (store) => store.getAll())) ?? [];
}

export async function getAllBatteryReadings(): Promise<BatteryReading[]> {
  return (await tx<BatteryReading[]>('battery_readings', 'readonly', (store) => store.getAll())) ?? [];
}

export async function getAllBookmarks(): Promise<Bookmark[]> {
  return (await tx<Bookmark[]>('bookmarks', 'readonly', (store) => store.getAll())) ?? [];
}

export async function clearPackets(): Promise<void> {
  await tx('packet_records', 'readwrite', (store) => store.clear());
}
