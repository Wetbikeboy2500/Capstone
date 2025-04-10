import { AnalysisResult } from './types';

// Using IndexedDB database configuration
const DB_NAME = 'EmailSafetyScanner';
const STORE_NAME = 'analyzedEmails';
const DB_VERSION = 1;

// Initialize IndexedDB
export function initDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = (event) => {
      console.error('Error opening IndexedDB:', event);
      reject('Error opening IndexedDB');
    };
    
    request.onsuccess = (event) => {
      resolve((event.target as IDBOpenDBRequest).result);
    };
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'hash' });
      }
    };
  });
}

// Get analyzed email from IndexedDB
export async function getAnalyzedEmail(hash: string): Promise<AnalysisResult | null> {
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(hash);
      
      request.onerror = () => {
        reject('Error getting email from IndexedDB');
      };
      
      request.onsuccess = () => {
        if (request.result) {
          resolve(request.result.result);
        } else {
          resolve(null);
        }
      };
    });
  } catch (error) {
    console.error('Error accessing IndexedDB:', error);
    return null;
  }
}

// Store analyzed email in IndexedDB
export async function storeAnalyzedEmail(hash: string, result: AnalysisResult): Promise<void> {
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put({ hash, result });
      
      request.onerror = () => {
        reject('Error storing email in IndexedDB');
      };
      
      request.onsuccess = () => {
        resolve();
      };
    });
  } catch (error) {
    console.error('Error storing in IndexedDB:', error);
  }
}

// Clear analyzed emails from IndexedDB
export async function clearAnalyzedEmails(): Promise<void> {
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();
      
      request.onerror = () => {
        reject('Error clearing IndexedDB');
      };
      
      request.onsuccess = () => {
        resolve();
      };
    });
  } catch (error) {
    console.error('Error clearing IndexedDB:', error);
  }
}