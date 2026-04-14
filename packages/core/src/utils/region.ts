/**
 * @kite-vpn/core — Region detection utility
 *
 * Detects geographic regions from proxy node names using regex patterns.
 * Supports Chinese and English names, country codes, and major city names.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegionInfo {
  /** Region display name (Chinese) */
  name: string
  /** Emoji flag for the region */
  emoji: string
}

interface RegionPattern {
  name: string
  emoji: string
  pattern: RegExp
}

// ---------------------------------------------------------------------------
// Region pattern database
// ---------------------------------------------------------------------------

const REGION_PATTERNS: readonly RegionPattern[] = [
  { name: '香港', emoji: '🇭🇰', pattern: /香港|HK|Hong\s*Kong|Hongkong/i },
  { name: '台湾', emoji: '🇹🇼', pattern: /台湾|TW|Taiwan/i },
  { name: '日本', emoji: '🇯🇵', pattern: /日本|JP|Japan|Tokyo|Osaka/i },
  { name: '新加坡', emoji: '🇸🇬', pattern: /新加坡|SG|Singapore/i },
  { name: '美国', emoji: '🇺🇸', pattern: /美国|US|United\s*States|America|Los\s*Angeles|San\s*Jose|Seattle|Dallas|New\s*York|Chicago|Miami|Silicon\s*Valley|SiliconValley/i },
  { name: '韩国', emoji: '🇰🇷', pattern: /韩国|KR|Korea|Seoul/i },
  { name: '英国', emoji: '🇬🇧', pattern: /英国|UK|United\s*Kingdom|Britain|London/i },
  { name: '德国', emoji: '🇩🇪', pattern: /德国|DE|Germany|Frankfurt/i },
  { name: '法国', emoji: '🇫🇷', pattern: /法国|FR|France|Paris/i },
  { name: '加拿大', emoji: '🇨🇦', pattern: /加拿大|CA|Canada|Toronto|Vancouver|Montreal/i },
  { name: '澳大利亚', emoji: '🇦🇺', pattern: /澳大利亚|澳洲|AU|Australia|Sydney|Melbourne/i },
  { name: '印度', emoji: '🇮🇳', pattern: /印度|IN|India|Mumbai|Bangalore/i },
  { name: '俄罗斯', emoji: '🇷🇺', pattern: /俄罗斯|RU|Russia|Moscow/i },
  { name: '荷兰', emoji: '🇳🇱', pattern: /荷兰|NL|Netherlands|Amsterdam/i },
  { name: '土耳其', emoji: '🇹🇷', pattern: /土耳其|TR|Turkey|Türkiye|Istanbul/i },
  { name: '阿根廷', emoji: '🇦🇷', pattern: /阿根廷|AR|Argentina|Buenos\s*Aires/i },
  { name: '巴西', emoji: '🇧🇷', pattern: /巴西|BR|Brazil|São\s*Paulo|Sao\s*Paulo/i },
  { name: '泰国', emoji: '🇹🇭', pattern: /泰国|TH|Thailand|Bangkok/i },
  { name: '菲律宾', emoji: '🇵🇭', pattern: /菲律宾|PH|Philippines|Manila/i },
  { name: '马来西亚', emoji: '🇲🇾', pattern: /马来西亚|MY|Malaysia|Kuala\s*Lumpur/i },
  { name: '印度尼西亚', emoji: '🇮🇩', pattern: /印度尼西亚|印尼|ID|Indonesia|Jakarta/i },
  { name: '越南', emoji: '🇻🇳', pattern: /越南|VN|Vietnam|Hanoi|Ho\s*Chi\s*Minh/i },
  { name: '爱尔兰', emoji: '🇮🇪', pattern: /爱尔兰|IE|Ireland|Dublin/i },
  { name: '波兰', emoji: '🇵🇱', pattern: /波兰|PL|Poland|Warsaw/i },
  { name: '瑞士', emoji: '🇨🇭', pattern: /瑞士|CH|Switzerland|Zurich/i },
  { name: '瑞典', emoji: '🇸🇪', pattern: /瑞典|SE|Sweden|Stockholm/i },
  { name: '以色列', emoji: '🇮🇱', pattern: /以色列|IL|Israel|Tel\s*Aviv/i },
  { name: '南非', emoji: '🇿🇦', pattern: /南非|ZA|South\s*Africa|Johannesburg/i },
  { name: '意大利', emoji: '🇮🇹', pattern: /意大利|IT|Italy|Milan|Rome|Roma/i },
  { name: '西班牙', emoji: '🇪🇸', pattern: /西班牙|ES|Spain|Madrid|Barcelona/i },
  { name: '乌克兰', emoji: '🇺🇦', pattern: /乌克兰|UA|Ukraine|Kyiv|Kiev/i },
  { name: '哈萨克斯坦', emoji: '🇰🇿', pattern: /哈萨克斯坦|KZ|Kazakhstan/i },
  { name: '澳门', emoji: '🇲🇴', pattern: /澳门|MO|Macau|Macao/i },
] as const

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempts to detect a geographic region from a proxy node's display name.
 *
 * Iterates through known region patterns and returns the first match.
 * Returns `undefined` when no region can be determined.
 *
 * @param name - The proxy node display name to inspect
 * @returns Region info with name and emoji, or `undefined`
 */
export function detectRegion(name: string): RegionInfo | undefined {
  if (!name) {
    return undefined
  }

  for (const region of REGION_PATTERNS) {
    if (region.pattern.test(name)) {
      return { name: region.name, emoji: region.emoji }
    }
  }

  return undefined
}
