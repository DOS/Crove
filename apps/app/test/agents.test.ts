// What the AI agents screens decide on their own (ADR-0029, issue #258).
import { describe, expect, it } from 'vitest';
import { agentPermissions, budgetUsage, chartTree, holderCandidates, isBudgetAmount, socialPostOf } from '../src/lib/agents.ts';

const titles = (nodes: ReturnType<typeof chartTree<{ id: string; reportsTo: string | null }>>): unknown =>
  nodes.map((n) => (n.children.length ? { [n.position.id]: titles(n.children) } : n.position.id));

describe('chartTree', () => {
  it('nests positions under their managers, roots first, in order', () => {
    const tree = chartTree([
      { id: 'cfo', reportsTo: null },
      { id: 'acc1', reportsTo: 'cfo' },
      { id: 'ops', reportsTo: null },
      { id: 'acc2', reportsTo: 'cfo' },
      { id: 'clerk', reportsTo: 'acc1' },
    ]);
    expect(titles(tree)).toEqual([{ cfo: [{ acc1: ['clerk'] }, 'acc2'] }, 'ops']);
  });

  it('puts a position whose manager is missing at the root, and shows a cycle once without looping', () => {
    expect(titles(chartTree([{ id: 'a', reportsTo: 'gone' }]))).toEqual(['a']);
    expect(titles(chartTree([{ id: 'self', reportsTo: 'self' }]))).toEqual(['self']);
    const cycle = chartTree([
      { id: 'x', reportsTo: 'y' },
      { id: 'y', reportsTo: 'x' },
    ]);
    expect(titles(cycle)).toEqual([{ x: ['y'] }]);
  });
});

describe('agentPermissions', () => {
  it('lets owners and admins stop AI, owners manage, and members work on tasks', () => {
    expect(agentPermissions('owner')).toEqual({ stop: true, manage: true, budgets: true, tasks: true });
    expect(agentPermissions('admin')).toEqual({ stop: true, manage: false, budgets: true, tasks: true });
    expect(agentPermissions('member')).toEqual({ stop: false, manage: false, budgets: false, tasks: true });
    expect(agentPermissions('viewer')).toEqual({ stop: false, manage: false, budgets: false, tasks: false });
    expect(agentPermissions(undefined)).toEqual({ stop: false, manage: false, budgets: false, tasks: false });
  });
});

describe('budgets', () => {
  it('accepts the amounts the server accepts', () => {
    for (const ok of ['0', '150', '150.5', '1.123456', ' 12 ']) expect(isBudgetAmount(ok), ok).toBe(true);
    for (const bad of ['', '-1', '1.1234567', '1e3', '1,5', '1234567890123']) expect(isBudgetAmount(bad), bad).toBe(false);
  });

  it('says how far a budget is spent, exactly and as the run gate counts it', () => {
    expect(budgetUsage('0', '100', 80)).toEqual({ percent: 0, state: 'ok' });
    expect(budgetUsage('79.999999', '100', 80)).toEqual({ percent: 79, state: 'ok' });
    expect(budgetUsage('80', '100', 80)).toEqual({ percent: 80, state: 'warn' });
    // Spent at the limit: a hard-stop budget refuses runs (spent >= limit).
    expect(budgetUsage('100.000000', '100', 80)).toEqual({ percent: 100, state: 'spent' });
    expect(budgetUsage('0.1', '0.3', 50)).toEqual({ percent: 33, state: 'ok' });
    expect(budgetUsage('0.2', '0.3', 50)).toEqual({ percent: 66, state: 'warn' });
    expect(budgetUsage('50000', '1', 80)).toEqual({ percent: 999, state: 'spent' });
    expect(budgetUsage('0', '0', 80).state).toBe('spent');
  });
});

describe('holderCandidates', () => {
  const templateRoles = new Map([
    ['accountant', 'accountant'],
    ['clerk', 'clerk'],
  ]);
  const agents = [
    { id: 'acc1', templateKey: 'accountant', status: 'active' },
    { id: 'acc2', templateKey: 'accountant', status: 'active' },
    { id: 'accOff', templateKey: 'accountant', status: 'paused' },
    { id: 'clk', templateKey: 'clerk', status: 'active' },
  ];
  const positions = [
    { id: 'p1', holder: { type: 'agent', agentId: 'acc1' } },
    { id: 'p2', holder: null },
    { id: 'p3', holder: { type: 'user' } },
  ];
  const ids = (list: Array<{ id: string }>) => list.map((a) => a.id);

  it('offers active agents of the position role that hold no other position', () => {
    expect(ids(holderCandidates({ id: 'p2', roleKey: 'accountant' }, agents, positions, templateRoles))).toEqual(['acc2']);
  });

  it('keeps the agent that holds this very position, so the select can show it', () => {
    expect(ids(holderCandidates({ id: 'p1', roleKey: 'accountant' }, agents, positions, templateRoles))).toEqual(['acc1', 'acc2']);
  });

  it('offers none of another role, or any before the templates are known', () => {
    expect(ids(holderCandidates({ id: 'p2', roleKey: 'auditor' }, agents, positions, templateRoles))).toEqual([]);
    expect(ids(holderCandidates({ id: 'p2', roleKey: 'accountant' }, agents, positions, new Map()))).toEqual([]);
  });
});

describe('socialPostOf', () => {
  it("names the Social post a content agent's task is about (#1193), and nothing else", () => {
    const id = '0b5c6f7e-1d2a-4c3b-9e8f-7a6b5c4d3e2f';
    expect(socialPostOf({ type: 'social.post', id })).toBe(id);
    expect(socialPostOf({ type: 'kernel.proposal', id })).toBeNull();
    expect(socialPostOf({ type: 'social.post', id: 'not-a-uuid' })).toBeNull();
    expect(socialPostOf(null)).toBeNull();
    expect(socialPostOf('social.post')).toBeNull();
  });
});
