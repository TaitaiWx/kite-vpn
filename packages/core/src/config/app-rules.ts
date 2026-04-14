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

export function generateAppProxyGroups(nodeNames: string[]): Array<{ name: string; type: 'select'; proxies: string[] }> {
  const defaultChoices = ['🔰 节点选择', 'DIRECT', 'REJECT', '♻️ 自动选择']

  return APP_GROUPS.map((group) => ({
    name: group.name,
    type: 'select' as const,
    proxies: [...defaultChoices, ...nodeNames.filter((n) => !defaultChoices.includes(n)).slice(0, 5)],
  }))
}
