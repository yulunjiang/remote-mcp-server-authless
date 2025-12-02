/**
 * Usage Agent: 使用者用量取得 Agent
 * 
 * 功能：
 * - 使用 function calling tool 取得使用者網路用量資料
 * - 未來將改為 MCP 方式連接用量查詢服務
 * - 作為獨立 Agent，可被主 Agent 呼叫
 * 
 * 注意：此 Agent 只使用 function calling tool，不混用 MCP
 */

import { Agent, tool } from '@openai/agents';
import { z } from 'zod';
import { retrieveUsage } from './usage-helper.js';
import { getCurrentUserId } from '../agent/context-store.js';
import dotenv from 'dotenv';

// 載入環境變數
dotenv.config();

/**
 * 定義 retrieveUsage 工具（自動取得 userId from context store）
 */
const retrieveUsageTool = tool({
  name: 'retrieveUsage',
  description: '取得目前使用者過去3個月的行動網路用量資料，用於分析漫遊需求。系統會自動提供 userId，不需要參數。',
  parameters: z.object({
    // 空物件 - 不需要參數，userId 從 context store 自動取得
  }),
  execute: async () => {
    // 從 context store 取得 userId
    const userId = getCurrentUserId() || 'default-user';
    console.log(`[Usage Agent] Calling retrieveUsage for userId from context: ${userId}`);
    const usageData = await retrieveUsage(userId);
    return usageData;
  }
});

/**
 * 建立 Usage Agent
 * 
 * 此 Agent 專門負責取得使用者用量資料
 */
export function createUsageAgent() {
  return new Agent({
    name: 'Usage Agent',
    model: 'gpt-4o',
    instructions: `
你是一個專門查詢使用者網路用量的助理。

你的任務：
1. 使用 retrieveUsage 工具取得目前使用者的網路用量資料
2. **重要：直接呼叫 retrieveUsage，不需要提供任何參數（系統會自動提供 userId）**
3. 直接回傳工具輸出的原始資料，不要額外包裝或格式化

重要：
- 工具名稱：retrieveUsage
- **不需要任何參數** - userId 會自動從 session 取得
- 直接使用工具回傳的資料，不需要轉換格式
    `.trim(),
    tools: [retrieveUsageTool]
  });
}

/**
 * 取得指定使用者的網路用量資料
 * 
 * @param {string} userId - 使用者 ID
 * @returns {Promise<UsageData>} 用量資料
 */
export async function getUserUsage(userId) {
  console.log(`[Usage Agent] getUserUsage called - userId: ${userId}`);
  
  try {
    // 開發階段：直接使用 mock 資料
    if (process.env.USE_MOCK_DATA === 'true') {
      console.log('[Usage Agent] Using mock data (USE_MOCK_DATA=true)');
      return await retrieveUsage(userId);
    }

    // 生產環境：使用 Agent 執行
    console.log(`[Usage Agent] 正在取得使用者 ${userId} 的用量資料...`);
    
    const { run } = await import('@openai/agents');
    const usageAgent = createUsageAgent();
    
    const result = await run(
      usageAgent,
      `請使用 retrieveUsage 工具查詢使用者 "${userId}" 的網路用量資料。`
    );

    console.log('[Usage Agent] Run result:', JSON.stringify({
      hasNewItems: !!result.newItems,
      newItemsCount: result.newItems?.length,
      finalOutputLength: result.finalOutput?.length
    }));

    // 從工具輸出擷取資料
    let usageData = null;
    if (Array.isArray(result.newItems)) {
      for (const item of result.newItems) {
        if (item.type === 'function_output' || item.type === 'function_call_output') {
          try {
            usageData = typeof item.output === 'string' ? JSON.parse(item.output) : item.output;
            console.log(`[Usage Agent] Found usage data:`, usageData);
            break;
          } catch (err) {
            console.warn('[Usage Agent] Failed to parse function output:', err.message);
          }
        }
      }
    }

    if (!usageData) {
      console.warn('[Usage Agent] No usage data found in tool output, using mock');
      return await retrieveUsage(userId);
    }

    console.log(`[Usage Agent] 成功取得使用者 ${userId} 的用量資料`);
    return usageData;
    
  } catch (error) {
    console.error('[Usage Agent] getUserUsage 失敗:', error.message, error.stack);
    throw new Error(`無法取得使用者 ${userId} 的用量資料`);
  }
}
