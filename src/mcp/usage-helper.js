/**
 * MCP Helper: 使用量資料取得
 * 
 * 功能：
 * - 呼叫 MCP 服務取得使用者過去 3 個月的網路用量
 * - 計算月平均用量
 * - 分類用量等級（高/中/低）
 * - 處理 MCP 失敗的降級策略
 */

import dotenv from 'dotenv';

// 載入環境變數
dotenv.config();

/**
 * 取得使用者的網路用量資料（過去 3 個月）
 * 
 * @param {string} userId - 使用者 ID
 * @returns {Promise<UsageData>} 用量資料物件
 * @throws {Error} 當 MCP 服務無法取得資料時
 */
export async function retrieveUsage(userId) {
  console.log(`[MCP] retrieveUsage called - userId: ${userId}`);
  try {
    console.log(`[MCP] 正在取得使用者 ${userId} 的用量資料...`);
    
    // TODO: 實際整合 MCP 客戶端
    // 目前使用模擬資料進行開發
    const mockUsageData = await simulateMCPUsageRetrieval(userId);
    
    // 計算月平均用量
    const totalGB = mockUsageData.months.reduce((sum, m) => sum + m.usageGB, 0);
    const averageGB = totalGB / mockUsageData.months.length;
    
    // 分類用量（FR-010）
    let category;
    if (averageGB > 20) {
      category = 'high';
    } else if (averageGB >= 5) {
      category = 'medium';
    } else {
      category = 'low';
    }
    
    // 計算日期範圍
    const periodStart = mockUsageData.months[0].month + '-01';
    const periodEnd = mockUsageData.months[mockUsageData.months.length - 1].month + '-31';
    
    const usageData = {
      months: mockUsageData.months,
      averageGB: parseFloat(averageGB.toFixed(1)),
      category,
      periodStart,
      periodEnd,
      retrievedAt: new Date().toISOString(),
      source: 'mcp'
    };
    
    console.log(`[MCP] 成功取得用量資料：月平均 ${averageGB.toFixed(1)}GB，分類：${category}`);
    console.log(`[MCP] retrieveUsage success - averageGB: ${averageGB.toFixed(1)}, category: ${category}`);
    
    return usageData;
    
  } catch (error) {
    console.error('[MCP] retrieveUsage 失敗:', error.message);
    console.error('[MCP] retrieveUsage failed:', error.message);
    throw new Error('無法取得用量資料');
  }
}

/**
 * 模擬 MCP 服務呼叫（開發階段使用）
 * 
 * 真實環境中應替換為實際的 MCP 客戶端呼叫
 * 
 * @param {string} userId - 使用者 ID
 * @returns {Promise<object>} 模擬的 MCP 回應
 */
async function simulateMCPUsageRetrieval(userId) {
  // 模擬網路延遲
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // 根據 userId 生成不同的模擬資料（開發測試用）
  const userHash = userId.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const baseUsage = 10 + (userHash % 15); // 10-25 GB 範圍
  
  const now = new Date();
  const months = [];
  
  for (let i = 2; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const month = date.toISOString().slice(0, 7); // YYYY-MM
    const usageGB = parseFloat((baseUsage + (Math.random() * 5 - 2.5)).toFixed(1));
    
    months.push({
      month,
      usageGB
    });
  }
  
  return { months };
}

/**
 * 從使用者輸入建立用量資料（降級策略）
 * 
 * 當 MCP 服務失敗時使用
 * 
 * @param {number} estimatedGB - 使用者估計的月平均用量
 * @returns {UsageData} 用量資料物件
 */
export function createUsageFromUserInput(estimatedGB) {
  let category;
  if (estimatedGB > 20) {
    category = 'high';
  } else if (estimatedGB >= 5) {
    category = 'medium';
  } else {
    category = 'low';
  }
  
  // 建立簡化的用量資料
  return {
    months: [],
    averageGB: parseFloat(estimatedGB.toFixed(1)),
    category,
    periodStart: null,
    periodEnd: null,
    retrievedAt: new Date().toISOString(),
    source: 'user-input'
  };
}

/**
 * 建立預設用量資料（保守估計）
 * 
 * 當 MCP 失敗且使用者未提供輸入時使用
 * 
 * @returns {UsageData} 預設用量資料（中等分類）
 */
export function createDefaultUsage() {
  return {
    months: [],
    averageGB: 12.0,
    category: 'medium',
    periodStart: null,
    periodEnd: null,
    retrievedAt: new Date().toISOString(),
    source: 'default'
  };
}
