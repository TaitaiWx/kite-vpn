import type { RoutingRule } from '@kite-vpn/types'
import type { RuleProvider } from './generator.js'

const RULE_BASE_URL = 'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash'

interface AppGroupDef {
  name: string
  apps: string[]
}

export const APP_GROUPS: readonly AppGroupDef[] = [
  {
    name: '🤖 AI 服务',
    apps: ['OpenAI', 'Claude', 'Anthropic', 'Gemini', 'Bing', 'Copilot', 'Perplexity', 'HuggingFace'],
  },
  {
    name: '📋 Google',
    apps: ['Google', 'YouTube', 'Gmail', 'GoogleDrive', 'GoogleSearch'],
  },
  {
    name: '💬 社交媒体',
    apps: ['Telegram', 'Discord', 'Twitter', 'Facebook', 'Instagram', 'Reddit', 'WhatsApp', 'Line', 'KakaoTalk', 'Snapchat'],
  },
  {
    name: '🎬 国际流媒体',
    apps: ['Netflix', 'Disney', 'Spotify', 'YouTubeMusic', 'HBO', 'Hulu', 'AmazonPrimeVideo', 'AppleTV', 'Twitch', 'TikTok'],
  },
  {
    name: '🛠 开发者工具',
    apps: ['GitHub', 'Docker', 'NPM', 'StackOverflow', 'GitLab', 'JetBrains', 'Figma', 'Vercel', 'Cloudflare', 'AWS'],
  },
  {
    name: '🎮 游戏平台',
    apps: ['Steam', 'Epic', 'PlayStation', 'Nintendo', 'Xbox', 'EA', 'Riot'],
  },
  {
    name: '🍎 Apple',
    apps: ['Apple', 'AppStore', 'iCloud', 'AppleMusic', 'FaceTime', 'TestFlight'],
  },
  {
    name: 'Ⓜ️ Microsoft',
    apps: ['Microsoft', 'OneDrive', 'Teams', 'Azure', 'Bing', 'LinkedIn'],
  },
] as const

export function generateAppRuleProviders(): RuleProvider[] {
  const providers: RuleProvider[] = []
  const seen = new Set<string>()

  for (const group of APP_GROUPS) {
    for (const app of group.apps) {
      if (seen.has(app)) continue
      seen.add(app)
      providers.push({
        name: app,
        type: 'http',
        behavior: 'classical',
        url: `${RULE_BASE_URL}/${app}/${app}.yaml`,
        path: `./ruleset/${app}.yaml`,
        interval: 86400,
      })
    }
  }

  return providers
}

export function generateAppRules(): RoutingRule[] {
  const rules: RoutingRule[] = []

  for (const group of APP_GROUPS) {
    for (const app of group.apps) {
      rules.push({
        type: 'RULE-SET',
        payload: app,
        target: group.name,
      })
    }
  }

  return rules
}

interface ProxyGroupOutput {
  name: string
  type: 'select' | 'url-test'
  proxies: string[]
  url?: string
  interval?: number
  tolerance?: number
}

export function generateAppProxyGroups(nodeNames: string[]): ProxyGroupOutput[] {
  const realNodes = nodeNames.filter((n) => {
    // 过滤掉流量信息伪节点（"84.57 G | 500.00 G" 等）
    if (/^\d+\.\d+\s*[GMKT]?B?\s*\|/.test(n)) return false
    if (/Traffic|Expire|Reset/i.test(n)) return false
    return true
  })

  const groups: ProxyGroupOutput[] = []

  // ♻️ 自动选择：url-test 类型，自动测速选延迟最低的节点
  groups.push({
    name: '♻️ 自动选择',
    type: 'url-test',
    proxies: realNodes.length > 0 ? realNodes : ['DIRECT'],
    url: 'http://www.gstatic.com/generate_204',
    interval: 300,
    tolerance: 50,
  })

  // App 分类组：每个引用 节点选择 / 自动选择 / DIRECT
  const defaultChoices = ['🔰 节点选择', '♻️ 自动选择', 'DIRECT']
  for (const group of APP_GROUPS) {
    groups.push({
      name: group.name,
      type: 'select',
      proxies: defaultChoices,
    })
  }

  return groups
}
