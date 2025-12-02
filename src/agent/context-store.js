/**
 * Request Context Store
 * 
 * 用於在 agent 執行期間存儲請求相關的上下文資料（如 userId）
 * 使用 AsyncLocalStorage 確保多請求並發時的隔離性
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const asyncLocalStorage = new AsyncLocalStorage();

/**
 * 設置當前請求的 context
 * @param {Object} context - 上下文資料
 * @param {Function} callback - 在此 context 中執行的回調函數
 */
export function runWithContext(context, callback) {
  return asyncLocalStorage.run(context, callback);
}

/**
 * 取得當前 context 中的 userId
 * @returns {string|null} userId 或 null
 */
export function getCurrentUserId() {
  const context = asyncLocalStorage.getStore();
  return context?.userId || null;
}

/**
 * 取得完整的當前 context
 * @returns {Object|null} context 物件或 null
 */
export function getCurrentContext() {
  return asyncLocalStorage.getStore() || null;
}
