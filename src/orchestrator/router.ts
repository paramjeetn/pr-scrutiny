import type { Command } from '../types/index.js'

// Which agents run for each command
export type AgentName = 'SecurityAgent' | 'QualityAgent' | 'LLMAgent' | 'BlastRadiusAgent'

const COMMAND_AGENTS: Record<Command, AgentName[]> = {
  'review':          ['SecurityAgent', 'QualityAgent', 'LLMAgent', 'BlastRadiusAgent'],
  'review:security': ['SecurityAgent'],
  'review:perf':     ['QualityAgent'],
  're-review':       ['SecurityAgent', 'QualityAgent', 'LLMAgent', 'BlastRadiusAgent'],
  'summarize':       ['LLMAgent'],
  'ask':             ['LLMAgent'],
  'blast-radius':    ['BlastRadiusAgent'],
}

export function getAgentsForCommand(command: Command): AgentName[] {
  return COMMAND_AGENTS[command] ?? []
}
