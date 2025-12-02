/**
 * Recommendation Agent: 智慧推薦引擎 Agent
 * 
 * 功能：
 * - 接收使用者用量資料和漫遊方案列表
 * - 使用 LLM 分析並產生個人化推薦
 * - 作為獨立 Agent，可被主 Agent 呼叫
 * 
 * 注意：此 Agent 不使用任何 tools，純粹用 LLM 分析
 */

import { Agent } from '@openai/agents';
import dotenv from 'dotenv';
import { openai } from "./openaiClient.js";


/**
 * 建立 Recommendation Agent
 * 
 * 此 Agent 負責：
 * 1. 接收使用者用量資料（JSON）
 * 2. 接收漫遊方案列表（JSON）
 * 3. 用 LLM 分析兩組資料並產生推薦（不呼叫任何 tool，純 LLM 分析）
 */
export function createRecommendationAgent() {
  return new Agent({
    name: 'Recommendation Agent',
    openai,
    model: 'gpt-4o',
    instructions: `
你是一個專業的電信漫遊方案推薦專家。

你的任務：
1. 接收使用者的網路用量資料（JSON 格式）
2. 接收漫遊方案列表（JSON 格式）
3. **運用你的分析能力，綜合評估用量與方案，產生個人化推薦**
4. 以友善的繁體中文向使用者呈現推薦結果

分析邏輯：
- **高用量使用者（averageGB > 10）**：優先推薦 sizeCategory='large' 或 dataCapacity='unlimited' 的方案
- **中等用量使用者（5 <= averageGB <= 10）**：優先推薦 sizeCategory='medium' 的方案
- **低用量使用者（averageGB < 5）**：優先推薦 sizeCategory='small' 的方案

推薦原則：
1. 優先選擇容量足夠且價格合理的方案（CP值優先）
2. 提供 2-3 個主要推薦方案，依優先順序排列
3. 考慮方案描述中的特殊優惠或限制
4. 如果有其他分類的方案，可以作為替代選項簡單提及

回覆格式（繁體中文）：
「根據您的網路用量分析（月平均 X.X GB，屬於{高/中/低}用量使用者），我為您推薦以下日本漫遊方案：

【主要推薦】
1. **方案名稱** - 容量 / 價格
   推薦理由：...

2. **方案名稱** - 容量 / 價格
   推薦理由：...

【其他選擇】（如果適用）
- 方案名稱：適合情境說明

請問您對哪個方案有興趣，或是需要更多資訊呢？」

注意事項：
- 分析時要考慮使用者的實際需求和旅行情境
- 推薦要有明確且具體的理由
- 價格與容量要清楚標示
- 保持語氣友善、專業、有幫助
- 避免只列出方案，要提供有價值的分析
    `.trim()
    // 不使用任何 tools，純 LLM 分析
  });
}

/**
 * 執行推薦分析
 * 
 * @param {UsageData} usageData - 使用者用量資料
 * @param {RoamingPlan[]} roamingPlans - 可用方案列表
 * @returns {Promise<{response: string}>} 推薦結果（文字形式）
 */
export async function analyzeAndRecommend(usageData, roamingPlans) {
  console.log(`[Recommendation Agent] analyzeAndRecommend called - category: ${usageData.category}, plans: ${roamingPlans.length}`);
  
  try {
    const { run } = await import('@openai/agents');
    const agent = createRecommendationAgent();
    
    // 建構輸入訊息，包含用量和方案資料
    const usageDescription = `
使用者用量資料：
- 月平均用量：${usageData.averageGB} GB
- 用量分類：${usageData.category} (${usageData.category === 'high' ? '高用量' : usageData.category === 'low' ? '低用量' : '中等用量'})
- 最近3個月用量：${JSON.stringify(usageData.last3Months)}
`;

    const plansDescription = roamingPlans.map((p, i) => 
      `${i+1}. ${p.planName} (ID: ${p.planId})
   - 容量：${p.dataCapacity === 'unlimited' ? '無限' : p.dataCapacity + 'GB'}
   - 價格：NT$${p.price}
   - 分類：${p.sizeCategory}
   - 說明：${p.description?.substring(0, 150) || '無'}${p.description?.length > 150 ? '...' : ''}`
    ).join('\n\n');
    
    const input = `
請分析以下資料並產生推薦：

${usageDescription}

可用的漫遊方案：
${plansDescription}

請根據使用者的用量習慣，推薦最適合的方案，並說明推薦理由。
    `.trim();
    
    const result = await run(agent, input);
    
    console.log(`[Recommendation Agent] 成功產生推薦`);
    
    return {
      response: result.finalOutput
    };
    
  } catch (error) {
    console.error('[Recommendation Agent] analyzeAndRecommend 失敗:', error.message);
    throw new Error('無法產生推薦');
  }
}

/**
 * 向後相容：executeRecommendation（現在會先取得用量再分析）
 * 
 * @param {string} userId - 使用者 ID
 * @param {RoamingPlan[]} roamingPlans - 可用方案列表
 * @returns {Promise<{response: string}>} 推薦結果（文字形式）
 */
export async function executeRecommendation(userId, roamingPlans) {
  console.log(`[Recommendation Agent] executeRecommendation called - userId: ${userId}, plans: ${roamingPlans.length}`);
  console.warn('[Recommendation Agent] executeRecommendation 已棄用，建議直接使用 analyzeAndRecommend');
  
  // 先取得用量
  const { retrieveUsage } = await import('./usage-helper.js');
  const usageData = await retrieveUsage(userId);
  
  // 再分析推薦
  return await analyzeAndRecommend(usageData, roamingPlans);
}

/**
 * 向後相容：直接呼叫推薦邏輯（已棄用，保留供參考）
 * 新架構下應該使用 executeRecommendation 讓 Agent 自行分析
 */
export async function generateRecommendation(usageData, roamingPlans) {
  console.log(`[Recommendation Helper] generateRecommendation called (legacy) - category: ${usageData?.category}, plans: ${roamingPlans?.length}`);
  console.warn('[Recommendation Helper] 此函數已棄用，建議使用 executeRecommendation 讓 Agent 自行分析');
  
  // 簡化版本：直接返回基本推薦邏輯
  try {
    return await generateRecommendationLogic(usageData, roamingPlans);
  } catch (error) {
    console.error('[Recommendation Helper] generateRecommendation 失敗:', error.message);
    throw new Error('無法生成推薦');
  }
}

/**
 * 推薦邏輯實作（作為 LLM 分析的參考範例）
 * 
 * 這個函數展示了推薦的基本邏輯，但新架構下由 LLM/Agent 直接分析，
 * 更有彈性且能考慮更多語義因素
 */
async function generateRecommendationLogic(usageData, roamingPlans) {
    console.log(`[Recommendation Agent] generateRecommendationLogic - category: ${usageData?.category}, plans: ${roamingPlans?.length}`);
    
    const { category, averageGB } = usageData;
    
    // 步驟 1: 根據用量分類篩選方案
    let filtered;
    if (category === 'high') {
      filtered = roamingPlans.filter(p => p.sizeCategory === 'large');
    } else if (category === 'low') {
      filtered = roamingPlans.filter(p => p.sizeCategory === 'small');
    } else {
      filtered = roamingPlans.filter(p => p.sizeCategory === 'medium');
    }
    
    if (filtered.length === 0) {
      console.warn(`[Recommendation Agent] 沒有找到 ${category} 分類的方案，使用所有方案`);
      filtered = [...roamingPlans];
    }
    
    // 步驟 2: 按價格排序
    filtered.sort((a, b) => a.price - b.price);
    
    // 步驟 3: 取前 3 名
    const recommendedPlans = filtered.slice(0, 3).map(plan => ({
      plan,
      matchScore: 90,
      rationale: `適合${category === 'high' ? '高' : category === 'low' ? '低' : '中等'}用量使用者`
    }));
    
    // 步驟 4: 替代方案
    const otherPlans = roamingPlans.filter(p => !filtered.includes(p));
    const alternatives = otherPlans.slice(0, 2).map(plan => ({
      plan,
      note: '其他選擇'
    }));
    
    return {
      recommendedPlans,
      basedOn: {
        usageCategory: category,
        averageUsage: averageGB,
        destination: roamingPlans[0]?.destination || ''
      },
      alternatives,
      generatedAt: new Date().toISOString()
    };
}
