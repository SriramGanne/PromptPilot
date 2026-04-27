#!/usr/bin/env node

import { program } from 'commander';
import chalk from 'chalk';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import inquirer from 'inquirer';
import { install, remove } from '../src/installer.js';
import { getConfig, CONFIG_KEYS } from '../src/config.js';

const KEY_LABELS = {
  TOGETHER_API_KEY: 'Together AI API key',
  SUPABASE_URL: 'Supabase project URL',
  SUPABASE_SERVICE_ROLE_KEY: 'Supabase service role key',
  UPSTASH_REDIS_REST_URL: 'Upstash Redis REST URL',
  UPSTASH_REDIS_REST_TOKEN: 'Upstash Redis REST token',
};

program
  .name('promptpilot')
  .description('Intercepts and optimizes prompts before they reach Claude via MCP')
  .version('1.0.0');

// --------------------------------------------------------------------------
// promptpilot init
// --------------------------------------------------------------------------
program
  .command('init')
  .description('Install PromptPilot MCP server into .claude/settings.json and CLAUDE.md')
  .action(async () => {
    try {
      await install();
    } catch (err) {
      console.error(chalk.red('\n  Error during install:'), err.message);
      process.exit(1);
    }
  });

// --------------------------------------------------------------------------
// promptpilot remove
// --------------------------------------------------------------------------
program
  .command('remove')
  .description('Remove PromptPilot from .claude/settings.json and CLAUDE.md')
  .action(async () => {
    try {
      await remove();
    } catch (err) {
      console.error(chalk.red('\n  Error during remove:'), err.message);
      process.exit(1);
    }
  });

// --------------------------------------------------------------------------
// promptpilot status
// --------------------------------------------------------------------------
program
  .command('status')
  .description('Show PromptPilot status, cache entry count, and last run timestamp')
  .action(async () => {
    console.log(chalk.bold.cyan('\n  PromptPilot — Status\n'));

    // Check if MCP is configured
    const settingsPath = join(process.cwd(), '.claude', 'settings.json');
    let active = false;
    if (existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
        active = !!settings.mcpServers?.promptpilot;
      } catch { /* ignore */ }
    }

    console.log(`  MCP server: ${active ? chalk.green('Active') : chalk.red('Not installed')}`);
    if (!active) {
      console.log(chalk.gray('  Run: promptpilot init\n'));
    }

    // Try to get Redis cache count
    const config = getConfig();
    if (config.UPSTASH_REDIS_REST_URL && config.UPSTASH_REDIS_REST_TOKEN) {
      try {
        const { Redis } = await import('@upstash/redis');
        const redis = new Redis({
          url: config.UPSTASH_REDIS_REST_URL,
          token: config.UPSTASH_REDIS_REST_TOKEN,
        });
        const allEntries = await redis.hgetall('promptbuddy:cache');
        const count = allEntries ? Object.keys(allEntries).length : 0;
        const now = Date.now();
        const validCount = allEntries
          ? Object.values(allEntries).filter((raw) => {
              try {
                const e = typeof raw === 'string' ? JSON.parse(raw) : raw;
                return e.expiresAt > now;
              } catch { return false; }
            }).length
          : 0;
        console.log(`  Cache entries: ${chalk.cyan(validCount)} valid (${count} total, 24h TTL)`);
      } catch (err) {
        console.log(`  Cache entries: ${chalk.yellow('unavailable')} (${err.message})`);
      }
    } else {
      console.log(`  Cache entries: ${chalk.gray('Redis not configured')}`);
    }

    // Last run timestamp
    const statePath = join(homedir(), '.promptpilot', 'state.json');
    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        if (state.lastRunAt) {
          const d = new Date(state.lastRunAt);
          console.log(`  Last run:      ${chalk.cyan(d.toLocaleString())}`);
        }
      } catch { /* ignore */ }
    } else {
      console.log(`  Last run:      ${chalk.gray('never')}`);
    }

    console.log('');
  });

// --------------------------------------------------------------------------
// promptpilot config
// --------------------------------------------------------------------------
program
  .command('config')
  .description('Interactively set API keys, saved to ~/.promptpilot/config')
  .action(async () => {
    console.log(chalk.bold.cyan('\n  PromptPilot — Configure\n'));
    console.log(chalk.gray('  Keys are saved to ~/.promptpilot/config (JSON)\n'));

    const current = getConfig();
    const answers = {};

    for (const key of CONFIG_KEYS) {
      const hasValue = !!current[key];
      const { value } = await inquirer.prompt([
        {
          type: 'password',
          name: 'value',
          message: `  ${KEY_LABELS[key]}${hasValue ? chalk.gray(' (set — leave blank to keep)') : ''}:`,
          mask: '*',
        },
      ]);
      if (value && value.trim()) {
        answers[key] = value.trim();
      } else if (hasValue) {
        answers[key] = current[key];
      }
    }

    const configDir = join(homedir(), '.promptpilot');
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });

    const configPath = join(configDir, 'config');
    writeFileSync(configPath, JSON.stringify(answers, null, 2));

    const setKeys = Object.keys(answers);
    console.log(chalk.bold.green(`\n  ✔ Saved ${setKeys.length} key(s) to ~/.promptpilot/config\n`));
    if (setKeys.length > 0) {
      console.log(`  Keys set: ${chalk.green(setKeys.join(', '))}\n`);
    }
  });

program.parse(process.argv);
