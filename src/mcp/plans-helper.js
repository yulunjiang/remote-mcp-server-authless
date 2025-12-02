/**
 * Plan Agent: 漫遊方案取得 Agent
 * 
 * 功能：
 * - 使用 MCP SSE 連接方式呼叫 getRoamingPromotions 工具
 * - 為每個方案分類容量大小（小/中/大）
 * - 作為獨立 Agent，可被主 Agent 呼叫
 * 
 * 注意：此 Agent 只使用 MCP 工具，不混用 function calling
 */

import { Agent, MCPServerSSE } from '@openai/agents';
import dotenv from 'dotenv';
import { openai } from "./openaiClient.js";



// MCP Server SSE 連接配置
let mcpServer = null;

/**
 * 初始化 MCP SSE Server
 */
async function initializeMCPServer() {
  if (mcpServer) {
    return mcpServer;
  }

  // 從環境變數讀取 MCP SSE 端點 URL
  const mcpUrl = process.env.MCP_SSE_URL || 'https://roaming-mcp-dev-c4dehvegaabeeyd4.southeastasia-01.azurewebsites.net/sse';
  
  mcpServer = new MCPServerSSE({
    url: mcpUrl,
    name: 'Roaming Plans MCP Server',
  });

  try {
    await mcpServer.connect();
    console.log(`[Plan Agent] MCP SSE Server connected: ${mcpUrl}`);
  } catch (error) {
    console.error('[Plan Agent] Failed to connect to MCP SSE Server:', error);
    throw error;
  }

  return mcpServer;
}

/**
 * 建立 Plan Agent
 * 
 * 此 Agent 專門負責取得漫遊方案，使用 MCP SSE 連接
 * 注意：這是一個 async 函數，因為需要先初始化 MCP Server
 */
export async function createPlanAgent() {
  // 先初始化並連接 MCP Server
  const server = await initializeMCPServer();
  
  return new Agent({
    name: 'Plan Agent',
    openai,
    model: 'gpt-4o',
    instructions: `
你是一個專門查詢漫遊方案的助理。

你的任務：
1. 使用 getRoamingPromotions 工具取得指定國家的漫遊方案
2. 直接回傳工具輸出的原始資料，不要額外包裝或格式化

重要：
- 工具名稱：getRoamingPromotions
- 輸入參數：目的地國家（繁體中文，例如「日本」）
- 直接使用工具回傳的資料，不需要轉換格式
    `.trim(),
    // 設定 MCP Server
    mcpServers: [server]
  });
}

/**
 * 取得指定國家的漫遊方案列表
 * 
 * 此函數會初始化並執行 Plan Agent
 * 
 * @param {string} destination - 目的地國家（繁體中文）
 * @returns {Promise<RoamingPlan[]>} 方案列表
 */
export async function retrievePlans(destination) {
  console.log(`[Plan Agent] retrievePlans called - destination: ${destination}`);
  
  try {
    // 開發階段：使用模擬資料
    if (process.env.USE_MOCK_DATA === 'true') {
      console.log('[Plan Agent] Using mock data (USE_MOCK_DATA=true)');
      const mockPlans = await simulateMCPPlanRetrieval(destination);
      return mockPlans.map(plan => addSizeCategory(plan));
    }

    // 生產環境：使用 MCP SSE
    console.log(`[Plan Agent] 正在透過 MCP SSE 取得 ${destination} 的漫遊方案...`);
    
    // 建立 Plan Agent（會自動連接 MCP Server）
    const planAgent = await createPlanAgent();
    
    // 執行 Agent 查詢方案
    const { run } = await import('@openai/agents');
    const result = await run(
      planAgent,
      `請使用 getRoamingPromotions 工具查詢「${destination}」的漫遊方案。`
    );

    console.log('[Plan Agent] Run result:', JSON.stringify({
      hasNewItems: !!result.newItems,
      newItemsCount: result.newItems?.length,
      newItemsTypes: result.newItems?.map(i => i.type),
      finalOutputLength: result.finalOutput?.length
    }));

    // 優先從工具輸出擷取資料
    let rawPlans = [];
    if (Array.isArray(result.newItems)) {
      for (const item of result.newItems) {
        console.log(`[Plan Agent] Checking item type: ${item.type}`);
        if (item.type === 'function_output' || item.type === 'function_call_output') {
          console.log('[Plan Agent] Found function output:', typeof item.output, item.output?.substring?.(0, 200));
          // MCP 工具輸出通常在這裡，嘗試解析 JSON
          try {
            const data = typeof item.output === 'string' ? JSON.parse(item.output) : item.output;
            console.log('[Plan Agent] Parsed output keys:', Object.keys(data || {}));
            // 支援常見鍵名：plans、promotions、data、content
            const list = data?.plans || data?.promotions || data?.data || data?.content || (Array.isArray(data) ? data : null);
            if (Array.isArray(list)) {
              console.log(`[Plan Agent] Found ${list.length} plans in tool output`);
              rawPlans = list;
              break;
            }
          } catch (err) {
            console.warn('[Plan Agent] Failed to parse function output:', err.message);
          }
        }
      }
    }

    // 若工具輸出未擷取到，退回解析 finalOutput
    if (!rawPlans.length && typeof result.finalOutput === 'string') {
      console.log('[Plan Agent] Falling back to finalOutput parsing');
      try {
        const jsonMatch = result.finalOutput.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const plansData = JSON.parse(jsonMatch[0]);
          rawPlans = plansData.plans || plansData.promotions || plansData.data || [];
        }
      } catch (parseError) {
        console.warn('[Plan Agent] 無法從 finalOutput 提取 JSON:', parseError.message);
      }
    }

    // 轉換 MCP 回傳格式為內部格式並加上分類
    const plans = rawPlans.map(raw => {
      const plan = {
        planId: raw.ROAMING_SEQ || raw.planId || raw.id,
        planName: raw.PO_NAME || raw.planName || raw.name,
        provider: '遠傳電信',
        destination: raw.APPLY_COUNTRY || raw.destination || destination,
        dataCapacity: parseDataVolume(raw.DATA_VOLUME || raw.dataCapacity),
        duration: extractDuration(raw.PRO_DESC || raw.description || ''),
        price: parsePrice(raw.DATA_PRICE || raw.price),
        description: raw.PRO_DESC || raw.description || ''
      };
      return addSizeCategory(plan);
    });

    console.log(`[Plan Agent] 成功取得 ${plans.length} 個 ${destination} 漫遊方案`);
    return plans;
    
  } catch (error) {
    console.error('[Plan Agent] retrievePlans 失敗:', error.message, error.stack);
    throw new Error(`無法取得${destination}的方案資料`);
  }
}

/**
 * 解析 DATA_VOLUME 欄位（支援各種格式）
 * 例如: "12GB", "日付", "500MB", "每日最高收費", "10GB ", "5GB " 等
 */
function parseDataVolume(volume) {
  if (!volume) return 0;
  
  const str = String(volume).trim();
  
  // 無限/計日型方案
  if (str.includes('日付') || str.includes('每日') || str.includes('unlimited')) {
    return 'unlimited';
  }
  
  // 提取 GB 數值
  const gbMatch = str.match(/(\d+(?:\.\d+)?)\s*GB/i);
  if (gbMatch) {
    return parseFloat(gbMatch[1]);
  }
  
  // 提取 MB 並轉換為 GB
  const mbMatch = str.match(/(\d+(?:\.\d+)?)\s*MB/i);
  if (mbMatch) {
    return parseFloat(mbMatch[1]) / 1024;
  }
  
  // 若無法解析，回傳 0
  console.warn(`[Plan Agent] 無法解析 DATA_VOLUME: "${volume}"`);
  return 0;
}

/**
 * 解析 DATA_PRICE 欄位（支援各種格式）
 * 例如: "$129/天", "$988/12GB", " $888/10GB", "$288/天" 等
 */
function parsePrice(price) {
  if (typeof price === 'number') return price;
  if (!price) return 0;
  
  const str = String(price).trim();
  
  // 提取數字（支援 $、空格、/等分隔符）
  const match = str.match(/\$?\s*(\d+)/);
  if (match) {
    return parseInt(match[1]);
  }
  
  console.warn(`[Plan Agent] 無法解析 DATA_PRICE: "${price}"`);
  return 0;
}

/**
 * 從描述中提取天數
 */
function extractDuration(description) {
  const match = description.match(/(\d+)\s*天/);
  return match ? parseInt(match[1]) : 7; // 預設7天
}

/**
 * 為方案添加容量分類
 */
function addSizeCategory(plan) {
  let sizeCategory;
  const capacity = plan.dataCapacity;
  
  if (capacity === 'unlimited' || capacity > 20) {
    sizeCategory = 'large';
  } else if (capacity >= 5) {
    sizeCategory = 'medium';
  } else {
    sizeCategory = 'small';
  }
  
  return {
    ...plan,
    sizeCategory
  };
}

/**
 * 模擬 MCP 服務呼叫（開發階段使用）
 * 
 * 真實環境中應替換為實際的 MCP 客戶端呼叫
 * 
 * @param {string} destination - 目的地國家
 * @returns {Promise<RoamingPlan[]>} 模擬的方案列表
 */
async function simulateMCPPlanRetrieval(destination) {
  // 模擬網路延遲
  await new Promise(resolve => setTimeout(resolve, 800));
  
  // 模擬方案資料庫
  const planDatabase = {
    '日本': [
      {
        planId: 'jp-unlimited-7d',
        planName: '日本7天無限上網',
        provider: '遠傳電信',
        destination: '日本',
        dataCapacity: 'unlimited',
        duration: 7,
        price: 499,
        description: '7天內不限流量，適合重度使用者'
      },
      {
        planId: 'jp-30gb-14d',
        planName: '日本14天30GB',
        provider: '遠傳電信',
        destination: '日本',
        dataCapacity: 30,
        duration: 14,
        price: 899,
        description: '14天30GB大容量，適合長期旅遊'
      },
      {
        planId: 'jp-15gb-14d',
        planName: '日本14天15GB',
        provider: '遠傳電信',
        destination: '日本',
        dataCapacity: 15,
        duration: 14,
        price: 699,
        description: '14天15GB，適合一般使用'
      },
      {
        planId: 'jp-8gb-7d',
        planName: '日本7天8GB',
        provider: '遠傳電信',
        destination: '日本',
        dataCapacity: 8,
        duration: 7,
        price: 399,
        description: '短期旅遊中容量方案'
      },
      {
        planId: 'jp-3gb-7d',
        planName: '日本7天3GB',
        provider: '遠傳電信',
        destination: '日本',
        dataCapacity: 3,
        duration: 7,
        price: 299,
        description: '輕量方案，適合商務短期使用'
      }
    ],
    '韓國': [
      {
        planId: 'kr-unlimited-5d',
        planName: '韓國5天無限上網',
        provider: '遠傳電信',
        destination: '韓國',
        dataCapacity: 'unlimited',
        duration: 5,
        price: 399,
        description: '5天不限流量，追劇無負擔'
      },
      {
        planId: 'kr-20gb-10d',
        planName: '韓國10天20GB',
        provider: '遠傳電信',
        destination: '韓國',
        dataCapacity: 20,
        duration: 10,
        price: 699,
        description: '10天20GB，適合中期停留'
      },
      {
        planId: 'kr-10gb-7d',
        planName: '韓國7天10GB',
        provider: '遠傳電信',
        destination: '韓國',
        dataCapacity: 10,
        duration: 7,
        price: 499,
        description: '一週中容量方案'
      },
      {
        planId: 'kr-5gb-5d',
        planName: '韓國5天5GB',
        provider: '遠傳電信',
        destination: '韓國',
        dataCapacity: 5,
        duration: 5,
        price: 299,
        description: '短期輕量方案'
      }
    ],
    '美國': [
      {
        planId: 'us-unlimited-15d',
        planName: '美國15天無限上網',
        provider: '遠傳電信',
        destination: '美國',
        dataCapacity: 'unlimited',
        duration: 15,
        price: 1299,
        description: '15天不限流量，長途旅行首選'
      },
      {
        planId: 'us-25gb-14d',
        planName: '美國14天25GB',
        provider: '遠傳電信',
        destination: '美國',
        dataCapacity: 25,
        duration: 14,
        price: 999,
        description: '兩週大容量方案'
      },
      {
        planId: 'us-12gb-10d',
        planName: '美國10天12GB',
        provider: '遠傳電信',
        destination: '美國',
        dataCapacity: 12,
        duration: 10,
        price: 799,
        description: '十天中容量方案'
      },
      {
        planId: 'us-5gb-7d',
        planName: '美國7天5GB',
        provider: '遠傳電信',
        destination: '美國',
        dataCapacity: 5,
        duration: 7,
        price: 599,
        description: '一週商務方案'
      }
    ]
  };
  
  // 檢查是否有該國家的方案
  const plans = planDatabase[destination];
  
  if (!plans) {
    // 如果沒有該國家，回傳空陣列
    console.warn(`[MCP] 沒有找到 ${destination} 的方案資料`);
    return [];
  }
  
  return plans;
}
