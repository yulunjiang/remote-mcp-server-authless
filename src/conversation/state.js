/**
 * 對話狀態管理模組
 * 
 * 功能：
 * - 使用 OpenAI Agents SDK 的 OpenAIConversationsSession 管理對話歷史
 * - 提供會話建立、取得、更新功能
 * - 自動清理過期會話（30分鐘無活動）
 */

import { OpenAIConversationsSession } from '@openai/agents';

// 使用 Map 儲存會話元資料（不含對話歷史，歷史由 OpenAIConversationsSession 管理）
const sessions = new Map();

// 會話逾時時間（毫秒）
const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MINUTES || '30') * 60 * 1000;

/**
 * 建立新會話
 * 
 * @param {string} userId - 使用者識別碼
 * @returns {Promise<string>} sessionId - 新會話的唯一識別碼
 */
export async function createSession(userId) {
  // 建立 OpenAI ConversationsSession 實例（自動管理對話歷史）
  const conversationsSession = new OpenAIConversationsSession();
  const sessionId = await conversationsSession.getSessionId();
  
  const newSession = {
    // 基本資訊
    sessionId,
    userId,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    expiresAt: new Date(Date.now() + SESSION_TIMEOUT_MS),
    
    // OpenAI ConversationsSession 實例（管理對話歷史）
    conversationsSession,
    
    // 對話階段（per data-model.md 狀態機）
    phase: 'intent-detection', // intent-detection | confirmation | approval | data-collection | recommendation
    
    // 使用者意圖（per data-model.md UserIntent entity）
    intent: {
      destination: null,
      travelDates: {
        start: null,
        end: null
      },
      confirmed: false,
      userApproved: false,
      detectedAt: null,
      confirmedAt: null
    },
    
    // 用量資料（per data-model.md UsageData entity）
    usageData: null,
    
    // 漫遊方案列表（per data-model.md RoamingPlan entity）
    roamingPlans: [],
    
    // 推薦結果（per data-model.md Recommendation entity）
    recommendation: null,
    
    // 對話歷程（僅供 debug 與 UI 顯示，實際歷史由 conversationsSession 管理）
    messages: [],

    // Human-in-the-loop (HITL) 暫存：等待使用者批准的執行狀態
    // pendingRunState: string | null (序列化後的 RunState JSON)
    // pendingInterruptions: array (需要批准的工具呼叫項目摘要)
    pendingRunState: null,
    pendingInterruptions: []
  };
  
  sessions.set(sessionId, newSession);
  console.log(`[Session] 已建立新會話: ${sessionId}`);
  return sessionId;
}

/**
 * 取得會話狀態
 * 
 * @param {string} sessionId - 會話識別碼
 * @returns {object|null} 會話狀態物件，若不存在或已過期則回傳 null
 */
export function getSession(sessionId) {
  if (!sessionId || !sessions.has(sessionId)) {
    return null;
  }
  
  const session = sessions.get(sessionId);
  
  // 檢查會話是否過期
  if (new Date() > session.expiresAt) {
    sessions.delete(sessionId);
    return null;
  }
  
  return session;
}

/**
 * 更新會話狀態
 * 
 * @param {string} sessionId - 會話識別碼
 * @param {object} updates - 要更新的欄位（部分更新）
 * @returns {object|null} 更新後的會話狀態，若會話不存在則回傳 null
 */
export function updateSession(sessionId, updates) {
  const session = getSession(sessionId);
  
  if (!session) {
    return null;
  }
  
  // 截斷對話歷程（保留最近 20 輪，僅供 UI 顯示）
  const MAX_MESSAGES = 20;
  let messages = updates.messages || session.messages;
  if (messages && messages.length > MAX_MESSAGES) {
    console.log(`[Session] Truncating message history for ${sessionId} - ${messages.length} -> ${MAX_MESSAGES}`);
    messages = messages.slice(-MAX_MESSAGES);
  }
  
  // 合併更新內容（conversationsSession 實例保持不變）
  const updatedSession = {
    ...session,
    ...updates,
    messages,
    conversationsSession: session.conversationsSession, // 保留原始 OpenAIConversationsSession 實例
    lastActivityAt: new Date(),
    expiresAt: new Date(Date.now() + SESSION_TIMEOUT_MS) // 重置過期時間
  };
  
  sessions.set(sessionId, updatedSession);
  return updatedSession;
}

/**
 * 清理過期會話
 * 
 * 應定期執行（建議每分鐘一次）以釋放記憶體
 * 
 * @returns {number} 被清理的會話數量
 */
export function cleanupExpiredSessions() {
  const now = new Date();
  let cleanedCount = 0;
  
  for (const [sessionId, session] of sessions.entries()) {
    if (now > session.expiresAt) {
      sessions.delete(sessionId);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`[Session Cleanup] 已清理 ${cleanedCount} 個過期會話`);
  }
  
  return cleanedCount;
}

/**
 * 更新使用者意圖
 * 
 * @param {string} sessionId - 會話識別碼
 * @param {object} intentUpdates - 意圖更新內容
 * @returns {object|null} 更新後的會話狀態
 */
export function updateIntent(sessionId, intentUpdates) {
  const session = getSession(sessionId);
  
  if (!session) {
    return null;
  }
  
  const updatedIntent = {
    ...session.intent,
    ...intentUpdates
  };
  
  return updateSession(sessionId, { intent: updatedIntent });
}

/**
 * 階段轉換邏輯（per data-model.md 狀態機）
 * 
 * @param {string} sessionId - 會話識別碼
 * @param {string} newPhase - 新階段
 * @returns {object|null} 更新後的會話狀態
 */
export function transitionPhase(sessionId, newPhase) {
  const session = getSession(sessionId);
  
  if (!session) {
    return null;
  }
  
  // 驗證階段轉換邏輯
  const validTransitions = {
    'intent-detection': ['confirmation'],
    'confirmation': ['approval', 'intent-detection'], // 可返回重新偵測
    'approval': ['data-collection', 'confirmation'], // 可返回重新確認
    'data-collection': ['recommendation'],
    'recommendation': [] // 終點階段
  };
  
  const currentPhase = session.phase;
  const allowedTransitions = validTransitions[currentPhase] || [];
  
  if (!allowedTransitions.includes(newPhase)) {
    console.warn(`[階段轉換警告] 無效轉換: ${currentPhase} -> ${newPhase}`);
    return session;
  }
  
  console.log(`[階段轉換] ${sessionId}: ${currentPhase} -> ${newPhase}`);
  
  return updateSession(sessionId, { phase: newPhase });
}

/**
 * 設定等待批准的執行狀態 (Human-in-the-loop)
 * @param {string} sessionId
 * @param {string} stateString RunState.toString() 產生的序列化內容
 * @param {Array} interruptions 簡化後的中斷項目 [{ name, toolName, agentName }]
 */
export function setPendingRunState(sessionId, stateString, interruptions) {
  return updateSession(sessionId, {
    pendingRunState: stateString,
    pendingInterruptions: interruptions || []
  });
}

/**
 * 清除等待批准的執行狀態
 * @param {string} sessionId
 */
export function clearPendingRunState(sessionId) {
  return updateSession(sessionId, {
    pendingRunState: null,
    pendingInterruptions: []
  });
}

/**
 * 取得所有活躍會話數量（僅供監控使用）
 * 
 * @returns {number} 當前活躍會話數量
 */
export function getActiveSessionCount() {
  cleanupExpiredSessions(); // 先清理過期會話
  return sessions.size;
}
