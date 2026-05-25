// ─── Account service — manages accounts and balances ────────────

import { Account, AccountType, Money, Currency } from '../models/types';
import { DataStore } from '../models/store';
import { EventBus } from '../events/event-bus';
import { validateAccount, addMoney, subtractMoney, formatMoney } from '../utils/validation';
import { generateId } from '../utils/id';

export class AccountService {
  constructor(
    private store: DataStore,
    private events: EventBus,
  ) {}

  createAccount(name: string, type: AccountType, currency: Currency, initialBalance: number = 0): Account {
    const account: Account = {
      id: generateId('acc_'),
      name,
      type,
      balance: { amount: initialBalance, currency },
      createdAt: new Date(),
      isActive: true,
    };

    const errors = validateAccount(account);
    if (errors.length > 0) {
      throw new Error(`Invalid account: ${errors.join(', ')}`);
    }

    this.store.addAccount(account);
    return account;
  }

  getAccount(id: string): Account {
    const account = this.store.getAccount(id);
    if (!account) throw new Error(`Account ${id} not found`);
    return account;
  }

  listAccounts(): Account[] {
    return this.store.getAllAccounts().filter(a => a.isActive);
  }

  deactivateAccount(id: string): Account {
    const account = this.getAccount(id);
    if (account.balance.amount !== 0) {
      throw new Error(`Cannot deactivate account with balance ${formatMoney(account.balance)}`);
    }
    return this.store.updateAccount(id, { isActive: false });
  }

  applyDebit(accountId: string, amount: Money): Account {
    const account = this.getAccount(accountId);
    const newBalance = subtractMoney(account.balance, amount);

    if (newBalance.amount < 0 && account.type !== 'credit') {
      throw new Error(`Insufficient funds in ${account.name}`);
    }

    const updated = this.store.updateAccount(accountId, { balance: newBalance });
    this.events.emit('account:updated', { account: updated, change: -amount.amount }, 'AccountService');
    return updated;
  }

  applyCredit(accountId: string, amount: Money): Account {
    const account = this.getAccount(accountId);
    const newBalance = addMoney(account.balance, amount);
    const updated = this.store.updateAccount(accountId, { balance: newBalance });
    this.events.emit('account:updated', { account: updated, change: amount.amount }, 'AccountService');
    return updated;
  }

  getNetWorth(): Money {
    const accounts = this.listAccounts();
    if (accounts.length === 0) return { amount: 0, currency: 'USD' };

    const currency = accounts[0].balance.currency;
    let total = 0;
    for (const acc of accounts) {
      if (acc.balance.currency !== currency) {
        throw new Error('Mixed currencies — conversion not supported yet');
      }
      total += acc.balance.amount;
    }
    return { amount: total, currency };
  }

  getAccountSummary(): { type: AccountType; count: number; total: Money }[] {
    const accounts = this.listAccounts();
    const byType = new Map<AccountType, Account[]>();

    for (const acc of accounts) {
      const arr = byType.get(acc.type) ?? [];
      arr.push(acc);
      byType.set(acc.type, arr);
    }

    return [...byType.entries()].map(([type, accs]) => ({
      type,
      count: accs.length,
      total: {
        amount: accs.reduce((sum, a) => sum + a.balance.amount, 0),
        currency: accs[0].balance.currency,
      },
    }));
  }
}
