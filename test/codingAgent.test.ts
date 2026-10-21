import { describe, expect, it } from 'vitest';
import { codingAgentLaunch, codingAgentName, customCommandProblem, splitCommand } from '../src/codingAgent.js';

describe('coding agents', () => {
  it('starts each built-in agent with the prompt, Claude Code when unset', () => {
    expect(codingAgentLaunch(undefined, 'p')).toEqual({ command: 'claude', args: ['p'] });
    expect(codingAgentLaunch({ agent: 'pi' }, 'p')).toEqual({ command: 'pi', args: ['p'] });
    expect(codingAgentLaunch({ agent: 'gemini' }, 'p')).toEqual({ command: 'gemini', args: ['--prompt-interactive', 'p'] });
    expect(codingAgentName({ agent: 'cursor' })).toBe('Cursor CLI');
  });

  it('splits a custom command by words and quotes, without a shell', () => {
    expect(splitCommand(`  my-agent --flag "two words" 'it''s' ""  `)).toEqual(['my-agent', '--flag', 'two words', 'its', '']);
    expect(splitCommand('a $(rm -rf ~) ; b')).toEqual(['a', '$(rm', '-rf', '~)', ';', 'b']);
  });

  it('refuses a custom command with an unclosed quote or no program', () => {
    expect(customCommandProblem('aider --message')).toBeUndefined();
    expect(customCommandProblem('  ')).toMatch(/enter the command/);
    expect(customCommandProblem('aider --message "oops')).toBe('a quote is not closed');
    expect(customCommandProblem('"" --message')).toBe('the first word must name the program to run');
  });

  it('puts the prompt last in a custom command, or where it says {prompt}', () => {
    const prompt = 'review "this"; $(whoami)';
    expect(codingAgentLaunch({ agent: 'custom', command: 'aider --message' }, prompt)).toEqual({ command: 'aider', args: ['--message', prompt] });
    expect(codingAgentLaunch({ agent: 'custom', command: 'agent --msg={prompt} --yes' }, prompt)).toEqual({ command: 'agent', args: [`--msg=${prompt}`, '--yes'] });
    expect(codingAgentName({ agent: 'custom', command: 'aider --message' })).toBe('custom command (aider --message)');
  });
});
