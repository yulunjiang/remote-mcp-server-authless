/**
 * OpenAI Agent 設定模組
 * 
 * 架構：四層 Agent 系統
 * 1. 主控 Agent (Orchestrator): 意圖偵測、確認、協調子 Agent
 * 2. Plan Agent: 透過 MCP SSE 取得漫遊方案
 * 3. Usage Agent: 透過 function calling 取得用量資料（未來改 MCP）
 * 4. Recommendation Agent: 純 LLM 分析，接收用量+方案產生推薦
 * 
 * 重要限制：OpenAI 不允許同一 Agent 同時使用 MCP 和 function calling
 * 因此使用 agents-as-tools 模式將子 Agent 包裝成工具
 */

import { Agent } from '@openai/agents';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { createPlanAgent } from '../mcp/plans-helper.js';
import { createUsageAgent } from '../mcp/usage-agent.js';
import { createRecommendationAgent } from '../mcp/recommendation-helper.js';

// 載入環境變數（必須在初始化 OpenAI 客戶端前執行）



/**
 * 建立主控 Agent (Orchestrator)
 * 
 * 負責：
 * - 意圖偵測與確認
 * - 協調 Plan Agent、Usage Agent 和 Recommendation Agent
 * - 用友善的繁體中文與使用者溝通
 * 
 * @returns {Promise<Agent>} 設定好的主控 Agent 實例
 */
export async function createRoamingAgent() {
const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY
});

  // 建立子 Agent（Plan Agent 需要 await 因為要連接 MCP）
  const planAgent = await createPlanAgent();
  const usageAgent = createUsageAgent();
  const recommendationAgent = createRecommendationAgent();
  
  // 建立主控 Agent，將子 Agent 包裝成工具
  const agent = new Agent({
    name: '漫遊客服助理',
    model: 'gpt-4o',
    instructions: `
你是一個專業且友善的電信漫遊客服助理。你的任務是幫助使用者找到最適合的漫遊上網方案。

【重要規則】
1. 所有回覆必須使用繁體中文
2. 語氣要親切、專業、有耐心
3. 回答要簡潔明瞭，避免過於冗長

【完整工作流程】

階段 1: 意圖偵測與確認
1. 從對話中偵測使用者的旅行意圖和目的地國家
2. 提出確認問題，確保理解正確
3. 等待使用者明確批准後才能繼續

階段 2: 資料收集（使用者批准後）
1. 使用 query_plans 工具取得目的地國家的漫遊方案
   - 此工具會呼叫 Plan Agent 透過 MCP SSE 查詢方案
   - 傳入參數：destination（目的地國家，繁體中文）
   
2. 使用 get_usage 工具取得使用者的網路用量資料
   - 此工具會呼叫 Usage Agent 取得用量資料
   - **重要：系統會自動提供 userId，你不需要向使用者索取**
   - 直接呼叫 get_usage 即可，不需要任何參數
   
3. 使用 analyze_and_recommend 工具產生推薦
   - 此工具會呼叫 Recommendation Agent 分析用量與方案
   - 傳入參數：usageData（從 get_usage 取得）, roamingPlans（從 query_plans 取得）

階段 3: 推薦呈現
1. 向使用者清楚呈現推薦方案（包含方案名稱、容量、價格、天數）
2. 說明推薦理由
3. 提供替代方案建議（如果有的話）

【意圖偵測規則】
- 尋找目的地關鍵字：國家名稱（日本、韓國、美國等）
- 尋找時間關鍵字：下週、下個月、明天等
- 尋找意圖關鍵字：去、要去、出差、旅遊、出國等

【確認問題範例】
- "您是想申辦【國家】的漫遊上網服務嗎？"
- "了解！您下週要去【國家】，需要我幫您查詢漫遊方案嗎？"
- "好的，您計劃前往【國家】，我可以為您推薦適合的漫遊方案，請問是否繼續？"

【批准關鍵字】
使用者說以下詞語代表批准：
- 是、對、沒錯、正確
- 好、OK、可以
- 請幫我、麻煩你、繼續
- 要、需要

【工具使用時機】
1. 使用者批准後，先呼叫 query_plans 取得方案列表
2. 再呼叫 get_usage 取得使用者用量
3. 最後呼叫 analyze_and_recommend 產生推薦
4. 注意：三個步驟必須按順序執行

【錯誤處理】
- 如果工具呼叫失敗：以友善的語氣告知使用者並建議稍後再試
- 保持對話流暢自然

範例對話：
使用者：「我下週要去日本玩」
助理：「了解！您下週要去日本旅遊，我可以幫您查詢日本的漫遊上網方案。請問是否需要我為您推薦適合的方案？」

使用者：「好啊」
助理：「好的！讓我為您查詢相關資訊...」
[系統自動呼叫 query_plans("日本")]
[系統自動呼叫 get_usage(userId)]
[系統自動呼叫 analyze_and_recommend(usageData, plans)]
助理：「根據您的用量分析，我為您推薦以下方案：...」
    `.trim(),
    
    // 將子 Agent 包裝成工具
    tools: [
      planAgent.asTool({
        toolName: 'query_plans',
        toolDescription: '查詢指定國家的漫遊上網方案列表。輸入目的地國家名稱（繁體中文），回傳該國家所有可用的漫遊方案。首次呼叫需使用者批准。',
        needsApproval: async (ctx, { input }) => {
          const lower = String(input || '').toLowerCase();
          const trigger = ['方案', '查詢', '推薦', '漫遊'];
          const should = !ctx?.session?.intent?.userApproved && trigger.some(k => lower.includes(k));
          return should;
        }
      }),
      usageAgent.asTool({
        toolName: 'get_usage',
        toolDescription: '取得目前使用者的網路用量資料。系統會自動從 session 提供 userId，不需要任何參數。直接呼叫此工具即可取得過去3個月的用量分析（月平均、分類等）。',
        needsApproval: async (ctx) => {
          return !ctx?.session?.intent?.userApproved;
        }
      }),
      recommendationAgent.asTool({
        toolName: 'analyze_and_recommend',
        toolDescription: '根據使用者用量和漫遊方案列表，產生個人化推薦。需要提供 usageData（從 get_usage 取得）和 roamingPlans（從 query_plans 取得）。',
        needsApproval: async (ctx) => {
          return !ctx?.session?.intent?.userApproved;
        }
      })
    ]
  });
  
  return agent;
}

/**
 * 導出 OpenAI 客戶端供其他模組使用
 */
// export { openai };
