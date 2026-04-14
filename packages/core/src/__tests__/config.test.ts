import { describe, it, expect } from 'vitest'
import { generateMihomoConfig, DEFAULT_ENGINE_CONFIG, DEFAULT_RULES } from '../config/index.js'
import { generateAppRuleProviders, generateAppRules } from '../config/app-rules.js'
import type { ProxyNode, ProxyGroupConfig } from '@kite/types'
import { parse as parseYaml } from 'yaml'

const testNodes: ProxyNode[] = [
  { id: '1', name: 'HK-1', server: '1.1.1.1', port: 443, settings: { protocol: 'shadowsocks', method: 'aes-256-gcm', password: 'test' } },
  { id: '2', name: 'JP-1', server: '2.2.2.2', port: 443, settings: { protocol: 'trojan', password: 'pass' } },
]

const testGroups: ProxyGroupConfig[] = [
  { name: 'Proxy', type: 'select', proxies: ['HK-1', 'JP-1'] },
  { name: 'Auto', type: 'url-test', proxies: ['HK-1', 'JP-1'], url: 'http://www.gstatic.com/generate_204', interval: 300 },
]

describe('generateMihomoConfig', () => {
  it('generates valid YAML', () => {
    const yaml = generateMihomoConfig({
      engineConfig: DEFAULT_ENGINE_CONFIG,
      nodes: testNodes,
      groups: testGroups,
      rules: [...DEFAULT_RULES],
    })

    expect(yaml).toBeTruthy()
    const parsed = parseYaml(yaml)
    expect(parsed).toBeTruthy()
    expect(parsed['mixed-port']).toBe(7890)
    expect(parsed['mode']).toBe('rule')
  })

  it('includes all proxies', () => {
    const yaml = generateMihomoConfig({
      engineConfig: DEFAULT_ENGINE_CONFIG,
      nodes: testNodes,
      groups: testGroups,
      rules: [...DEFAULT_RULES],
    })

    const parsed = parseYaml(yaml)
    expect(parsed['proxies']).toHaveLength(2)
    expect(parsed['proxy-groups']).toHaveLength(2)
  })

  it('includes rules', () => {
    const yaml = generateMihomoConfig({
      engineConfig: DEFAULT_ENGINE_CONFIG,
      nodes: testNodes,
      groups: testGroups,
      rules: [...DEFAULT_RULES],
    })

    const parsed = parseYaml(yaml)
    expect(parsed['rules'].length).toBeGreaterThan(0)
    expect(parsed['rules'].some((r: string) => r.includes('MATCH'))).toBe(true)
  })

  it('includes rule-providers when provided', () => {
    const providers = generateAppRuleProviders()
    const appRules = generateAppRules()

    const yaml = generateMihomoConfig({
      engineConfig: DEFAULT_ENGINE_CONFIG,
      nodes: testNodes,
      groups: testGroups,
      rules: [...appRules, ...DEFAULT_RULES],
      ruleProviders: providers,
    })

    const parsed = parseYaml(yaml)
    expect(parsed['rule-providers']).toBeTruthy()
    expect(Object.keys(parsed['rule-providers']).length).toBeGreaterThan(0)
  })

  it('includes DNS config', () => {
    const yaml = generateMihomoConfig({
      engineConfig: DEFAULT_ENGINE_CONFIG,
      nodes: testNodes,
      groups: testGroups,
      rules: [...DEFAULT_RULES],
    })

    const parsed = parseYaml(yaml)
    expect(parsed['dns']).toBeTruthy()
    expect(parsed['dns']['enable']).toBe(true)
  })

  it('handles empty nodes', () => {
    const yaml = generateMihomoConfig({
      engineConfig: DEFAULT_ENGINE_CONFIG,
      nodes: [],
      groups: [],
      rules: [...DEFAULT_RULES],
    })

    const parsed = parseYaml(yaml)
    expect(parsed['proxies']).toHaveLength(0)
  })
})

describe('App Rules', () => {
  it('generates rule providers for all app groups', () => {
    const providers = generateAppRuleProviders()
    expect(providers.length).toBeGreaterThan(50)
    expect(providers.every((p) => p.url.includes('github'))).toBe(true)
    expect(providers.every((p) => p.behavior === 'classical')).toBe(true)
  })

  it('generates RULE-SET rules', () => {
    const rules = generateAppRules()
    expect(rules.length).toBeGreaterThan(50)
    expect(rules.every((r) => r.type === 'RULE-SET')).toBe(true)
  })
})
