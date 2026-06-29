export interface CustomerLookup {
  findWalletsByKeys(keys: string[]): Map<string, string>;
}
