import type { HostingerImapConfig } from "./imap-read-service.js";

export interface StoredGmailAccount {
  email: string;
  addedAt: string;
}

export type ConnectedMailAccount =
  | (StoredGmailAccount & { provider: "gmail"; read_only: false })
  | { email: string; provider: "hostinger-imap"; read_only: true };

export function resolveSingleMailAccount(
  requestedAccount: string,
  gmailAccounts: StoredGmailAccount[],
  hostingerConfig: HostingerImapConfig | null
): string {
  if (requestedAccount.trim().toLowerCase() === "all") {
    throw new Error("An exact account is required for this operation");
  }
  const accounts = resolveMailAccounts(requestedAccount, gmailAccounts, hostingerConfig);
  if (accounts.length !== 1) {
    throw new Error("An exact account is required for this operation");
  }
  return accounts[0];
}

export function isHostingerAccount(
  account: string,
  config: HostingerImapConfig | null
): boolean {
  return Boolean(config && account.trim().toLowerCase() === config.account);
}

export function listConnectedMailAccounts(
  gmailAccounts: StoredGmailAccount[],
  config: HostingerImapConfig | null
): ConnectedMailAccount[] {
  const accounts: ConnectedMailAccount[] = gmailAccounts
    .filter((account) => !isHostingerAccount(account.email, config))
    .map((account) => ({
      ...account,
      provider: "gmail" as const,
      read_only: false as const,
    }));
  if (config) {
    accounts.push({
      email: config.account,
      provider: "hostinger-imap",
      read_only: true,
    });
  }
  return accounts;
}

export function resolveMailAccounts(
  requestedAccount: string,
  gmailAccounts: StoredGmailAccount[],
  config: HostingerImapConfig | null
): string[] {
  const normalized = requestedAccount.trim().toLowerCase();
  if (normalized === "all") {
    const gmailOnly = gmailAccounts.filter(
      (account) => !isHostingerAccount(account.email, config)
    );
    if (gmailOnly.length === 0) {
      throw new Error("No Gmail accounts connected");
    }
    return gmailOnly.map((account) => account.email);
  }
  if (isHostingerAccount(normalized, config)) {
    return [config!.account];
  }
  const gmail = gmailAccounts.find(
    (account) => account.email.toLowerCase() === normalized
  );
  if (gmail) return [gmail.email];

  const available = listConnectedMailAccounts(gmailAccounts, config).map(
    (account) => account.email
  );
  throw new Error(
    `Account "${requestedAccount}" is not connected. Available accounts: ${
      available.join(", ") || "none"
    }`
  );
}

const HOSTINGER_READ_OPERATIONS = new Set([
  "list_emails",
  "batch_process",
  "get_email",
]);

export function assertMailOperationAllowed(
  account: string,
  operation: string,
  config: HostingerImapConfig | null
): void {
  if (
    isHostingerAccount(account, config) &&
    !HOSTINGER_READ_OPERATIONS.has(operation)
  ) {
    throw new Error(
      `Hostinger account ${config!.account} is read-only; ${operation} is disabled`
    );
  }
}
